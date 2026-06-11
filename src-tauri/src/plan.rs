use chrono::{Local, NaiveDate};
use uuid::Uuid;

use crate::models::ReadingPlan;

/// The reader's *local* calendar day — the single seam for all "today" math
/// (CORE-1014). Day boundaries resolve reader-local; stored timestamps stay
/// UTC/RFC3339. The lib.rs guardrail test pins day-boundary call sites here.
pub fn app_today() -> NaiveDate {
    Local::now().date_naive()
}

/// The reader-LOCAL calendar day of a stored UTC RFC3339 timestamp — the
/// companion seam to `app_today()`. Falls back to the bare `YYYY-MM-DD` prefix
/// for legacy/malformed values.
pub fn local_day_of(ts: &str) -> Option<NaiveDate> {
    match chrono::DateTime::parse_from_rfc3339(ts) {
        Ok(dt) => Some(dt.with_timezone(&Local).date_naive()),
        Err(_) => NaiveDate::parse_from_str(ts.get(..10).unwrap_or(ts), "%Y-%m-%d").ok(),
    }
}

/// The sitting length used until the reader chooses one (a steady sitting).
pub const DEFAULT_SITTING_MINUTES: i64 = 25;

/// A fresh import is PLAN-READY: no dates, no targets, no sitting length chosen
/// yet, and not begun. Pacing is silent and position-based — there is nothing
/// here a reader can fall "behind" on.
pub fn build_default_plan(book_id: &str) -> ReadingPlan {
    ReadingPlan {
        id: format!("plan_{}", Uuid::new_v4().simple()),
        book_id: book_id.to_string(),
        start_date: app_today().to_string(),
        status: "plan_ready".to_string(),
        activated_at: None,
        sitting_length_minutes: None,
    }
}

/// A friendly default name for a new plan when the reader doesn't give one:
/// "First attempt", "Second attempt", … then "Attempt N".
pub fn default_plan_label(attempt: usize) -> String {
    const WORDS: [&str; 9] = [
        "First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth", "Ninth",
    ];
    match WORDS.get(attempt.saturating_sub(1)) {
        Some(w) => format!("{w} attempt"),
        None => format!("Attempt {}", attempt.max(1)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    /// CORE-1014: `app_today()` IS the reader's local calendar day.
    #[test]
    fn app_today_is_the_local_day() {
        let before = chrono::Local::now().date_naive();
        let today = app_today();
        let after = chrono::Local::now().date_naive();
        assert!(
            today == before || today == after,
            "app_today() must be the local day, got {today} (local was {before}/{after})"
        );
    }

    /// CORE-1014 family: the timestamp→day seam.
    #[test]
    fn local_day_of_is_the_local_day_of_the_instant() {
        let ts = "2026-06-09T23:30:00Z";
        let expected = chrono::DateTime::parse_from_rfc3339(ts)
            .unwrap()
            .with_timezone(&chrono::Local)
            .date_naive();
        assert_eq!(local_day_of(ts), Some(expected));
        assert_eq!(local_day_of("2026-06-09T19:30:00-04:00"), Some(expected));
    }

    #[test]
    fn local_day_of_falls_back_to_the_date_prefix_for_legacy_values() {
        assert_eq!(local_day_of("2020-01-01"), Some(d(2020, 1, 1)));
        assert_eq!(local_day_of("2020-01-01 10:00:00"), Some(d(2020, 1, 1)));
        assert_eq!(local_day_of("garbage"), None);
    }

    #[test]
    fn default_plan_label_names_by_attempt() {
        assert_eq!(default_plan_label(1), "First attempt");
        assert_eq!(default_plan_label(2), "Second attempt");
        assert_eq!(default_plan_label(9), "Ninth attempt");
        assert_eq!(default_plan_label(10), "Attempt 10");
        assert_eq!(default_plan_label(0), "First attempt");
    }

    #[test]
    fn build_default_plan_is_plan_ready_with_no_dates_or_sitting_length() {
        let p = build_default_plan("b1");
        assert_eq!(p.status, "plan_ready");
        assert!(p.activated_at.is_none());
        assert!(p.sitting_length_minutes.is_none(), "sitting length chosen later");
    }
}
