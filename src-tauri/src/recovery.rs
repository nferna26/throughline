use anyhow::Result;
use chrono::{Duration, NaiveDate};
use serde::{Deserialize, Serialize};

use crate::models::ReadingPlan;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(tag = "kind")]
pub enum RecoveryOption {
    /// "Resume today" — always available, no schedule change.
    ResumeToday,
    /// "+10 min for next N sessions" — small daily bump until caught up.
    GentleCatchup { extra_minutes: i64, for_sessions: i64 },
    /// "Catch up on the weekend" — only when there's a weekend within reach.
    WeekendCatchup { weekend_starts_in_days: i64 },
    /// "Extend finish date by N days" — moves the goalpost, recomputes plan.
    ExtendFinish { add_days: i64, new_finish: String },
    /// "Restart current chapter" — reset progress on the in-flight section.
    RestartCurrentChapter,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RecoveryBundle {
    /// Always present, shame-free: "Next smallest step: 10 minutes."
    pub headline: String,
    pub days_behind: i64,
    pub options: Vec<RecoveryOption>,
}

pub const HEADLINE: &str = "Next smallest step: 10 minutes.";

/// Decide which recovery options to surface for a given days_behind value.
///
/// Rules:
/// - Resume Today is always offered.
/// - GentleCatchup is offered when 1–4 behind. Higher values bias to ExtendFinish.
/// - WeekendCatchup is offered only when there's a weekend day in the next 3 days.
/// - ExtendFinish is offered when >= 2 behind. Adds days_behind days by default.
/// - RestartCurrentChapter is offered when in_chapter is true (caller's choice).
pub fn options_for(days_behind: i64, today: NaiveDate, in_chapter: bool, finish_date: NaiveDate) -> Vec<RecoveryOption> {
    let mut out: Vec<RecoveryOption> = Vec::new();
    out.push(RecoveryOption::ResumeToday);

    if days_behind >= 1 && days_behind <= 4 {
        out.push(RecoveryOption::GentleCatchup {
            extra_minutes: 10,
            for_sessions: days_behind.max(1).min(4),
        });
    }

    if let Some(days_to_weekend) = days_until_next_weekend(today) {
        if days_behind >= 1 && days_to_weekend <= 3 {
            out.push(RecoveryOption::WeekendCatchup { weekend_starts_in_days: days_to_weekend });
        }
    }

    if days_behind >= 2 {
        let add = days_behind.max(2);
        let new_finish = finish_date + Duration::days(add);
        out.push(RecoveryOption::ExtendFinish {
            add_days: add,
            new_finish: new_finish.to_string(),
        });
    }

    if in_chapter {
        out.push(RecoveryOption::RestartCurrentChapter);
    }

    out
}

fn days_until_next_weekend(today: NaiveDate) -> Option<i64> {
    use chrono::Datelike;
    // Saturday = 6, Sunday = 7 in chrono's iso (or 5/6 in num_days_from_sunday — depends on weekday method)
    // Use weekday().num_days_from_monday(): Mon=0, Tue=1, Wed=2, Thu=3, Fri=4, Sat=5, Sun=6
    let dow = today.weekday().num_days_from_monday();
    if dow >= 5 {
        // It's already the weekend.
        Some(0)
    } else {
        Some((5 - dow as i64).max(0))
    }
}

pub fn build_bundle(days_behind: i64, today: NaiveDate, in_chapter: bool, finish_date: NaiveDate) -> RecoveryBundle {
    let options = options_for(days_behind.max(0), today, in_chapter, finish_date);
    RecoveryBundle {
        headline: HEADLINE.to_string(),
        days_behind: days_behind.max(0),
        options,
    }
}

/// Recompute daily_target_units for a plan whose finish date has shifted.
/// Preserves completed sections — only the remaining sections matter for the
/// new per-day target. The plan row should be UPDATEd with the result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecomputedPlan {
    pub new_target_finish_date: String,
    pub new_daily_target_units: Option<i64>,
    pub remaining_sections: i64,
    pub remaining_days: i64,
}

pub fn extend_finish_date(
    plan: &ReadingPlan,
    total_sections: i64,
    completed_sections: i64,
    today: NaiveDate,
    add_days: i64,
) -> Result<RecomputedPlan> {
    let current_finish = NaiveDate::parse_from_str(&plan.target_finish_date, "%Y-%m-%d")
        .or_else(|_| NaiveDate::parse_from_str(&plan.target_finish_date, "%Y-%m-%dT%H:%M:%S"))?;
    let new_finish = current_finish + Duration::days(add_days.max(0));
    let remaining_sections = (total_sections - completed_sections).max(0);
    let remaining_days = (new_finish.signed_duration_since(today).num_days() + 1).max(1);
    let daily_target = if remaining_sections == 0 {
        None
    } else {
        Some(((remaining_sections + remaining_days - 1) / remaining_days).max(1))
    };
    Ok(RecomputedPlan {
        new_target_finish_date: new_finish.to_string(),
        new_daily_target_units: daily_target,
        remaining_sections,
        remaining_days,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn d(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
    }

    #[test]
    fn resume_today_is_always_offered() {
        let opts = options_for(0, d(2026, 5, 25), false, d(2026, 6, 25));
        assert!(opts.contains(&RecoveryOption::ResumeToday));
    }

    #[test]
    fn gentle_catchup_offered_for_small_deficit() {
        let opts = options_for(2, d(2026, 5, 25), false, d(2026, 6, 25));
        assert!(opts.iter().any(|o| matches!(o, RecoveryOption::GentleCatchup { extra_minutes: 10, for_sessions: 2 })));
    }

    #[test]
    fn extend_finish_offered_when_significantly_behind() {
        let opts = options_for(3, d(2026, 5, 25), false, d(2026, 6, 25));
        assert!(opts.iter().any(|o| matches!(o, RecoveryOption::ExtendFinish { add_days: 3, .. })));
    }

    #[test]
    fn restart_chapter_only_when_in_chapter() {
        let with = options_for(1, d(2026, 5, 25), true, d(2026, 6, 25));
        assert!(with.contains(&RecoveryOption::RestartCurrentChapter));
        let without = options_for(1, d(2026, 5, 25), false, d(2026, 6, 25));
        assert!(!without.contains(&RecoveryOption::RestartCurrentChapter));
    }

    #[test]
    fn weekend_catchup_only_when_close_to_weekend() {
        // 2026-05-25 is a Monday → 4 days to Saturday → not offered
        let mon = options_for(2, d(2026, 5, 25), false, d(2026, 6, 25));
        assert!(!mon.iter().any(|o| matches!(o, RecoveryOption::WeekendCatchup { .. })));
        // 2026-05-28 is a Thursday → 1 day to Saturday → offered
        let thu = options_for(2, d(2026, 5, 28), false, d(2026, 6, 25));
        assert!(thu.iter().any(|o| matches!(o, RecoveryOption::WeekendCatchup { .. })));
    }

    #[test]
    fn headline_is_shame_free() {
        let b = build_bundle(5, d(2026, 5, 28), true, d(2026, 6, 25));
        assert_eq!(b.headline, "Next smallest step: 10 minutes.");
        // No "streak" or "broken" or punishment language.
        assert!(!b.headline.to_lowercase().contains("streak"));
        assert!(!b.headline.to_lowercase().contains("broken"));
        assert!(!b.headline.to_lowercase().contains("failed"));
    }

    #[test]
    fn extend_finish_recomputes_daily_target() {
        let plan = ReadingPlan {
            id: "p1".to_string(),
            book_id: "b1".to_string(),
            start_date: "2026-05-01".to_string(),
            target_finish_date: "2026-05-30".to_string(),
            daily_target_units: Some(1),
            days_per_week: 6,
            catchup_mode: "gentle".to_string(),
        };
        // 30 sections, 5 done, 5 days remaining (today=2026-05-26 → finish=2026-05-30)
        // Extend by 7 days → new finish = 2026-06-06 → days remaining 12
        // remaining_sections = 25 → daily target ceil(25/12) = 3 (rounded)
        let r = extend_finish_date(&plan, 30, 5, d(2026, 5, 26), 7).unwrap();
        assert_eq!(r.new_target_finish_date, "2026-06-06");
        assert_eq!(r.remaining_sections, 25);
        assert_eq!(r.remaining_days, 12);
        assert_eq!(r.new_daily_target_units, Some(3));
    }

    #[test]
    fn extend_finish_clears_target_when_all_done() {
        let plan = ReadingPlan {
            id: "p1".to_string(),
            book_id: "b1".to_string(),
            start_date: "2026-05-01".to_string(),
            target_finish_date: "2026-05-30".to_string(),
            daily_target_units: Some(1),
            days_per_week: 6,
            catchup_mode: "gentle".to_string(),
        };
        let r = extend_finish_date(&plan, 30, 30, d(2026, 5, 26), 7).unwrap();
        assert_eq!(r.remaining_sections, 0);
        assert_eq!(r.new_daily_target_units, None);
    }

    #[test]
    fn extend_finish_preserves_finish_when_add_zero() {
        let plan = ReadingPlan {
            id: "p1".to_string(),
            book_id: "b1".to_string(),
            start_date: "2026-05-01".to_string(),
            target_finish_date: "2026-05-30".to_string(),
            daily_target_units: Some(1),
            days_per_week: 6,
            catchup_mode: "gentle".to_string(),
        };
        let r = extend_finish_date(&plan, 30, 0, d(2026, 5, 26), 0).unwrap();
        assert_eq!(r.new_target_finish_date, "2026-05-30");
    }
}
