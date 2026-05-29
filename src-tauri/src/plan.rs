use anyhow::Result;
use chrono::{Duration, NaiveDate, Utc};
use uuid::Uuid;

use crate::models::{BookSection, FinishForecast, PaceState, ReadingPlan};

pub const DEFAULT_DAYS: i64 = 30;
/// Days after activation before a slip can surface (the first reading window is
/// grace — a freshly started book is never "off pace" on day one).
pub const GRACE_DAYS: i64 = 1;
/// A heavy-but-feasible daily section ceiling. Past this the plan is "unrealistic".
pub const MAX_SECTIONS_PER_DAY: f64 = 6.0;

pub fn build_default_plan(book_id: &str, sections: &[BookSection]) -> ReadingPlan {
    let start = Utc::now().naive_utc().date();
    let finish = start + Duration::days(DEFAULT_DAYS - 1);
    let assignable = sections.iter().filter(|s| s.assignable).count() as i64;
    let daily_target = if assignable == 0 {
        None
    } else {
        Some((assignable + DEFAULT_DAYS - 1) / DEFAULT_DAYS)
    };
    ReadingPlan {
        id: format!("plan_{}", Uuid::new_v4().simple()),
        book_id: book_id.to_string(),
        start_date: start.to_string(),
        target_finish_date: finish.to_string(),
        daily_target_units: daily_target,
        days_per_week: 6,
        catchup_mode: "gentle".to_string(),
        // A fresh import is PLAN-READY, not active: the pace clock does not run
        // and the book is never "behind" until the first session activates it.
        status: "plan_ready".to_string(),
        activated_at: None,
        original_finish_date: None,
    }
}

/// Daily section target to cover `remaining_sections` between `today` and
/// `finish` (inclusive of both ends). `None` when nothing remains. This is the
/// single source of the ceil-division used by both plan configuration (Setup
/// Sheet) and rebalance (extend finish), so the two always agree.
pub fn daily_target_for(remaining_sections: i64, today: NaiveDate, finish: NaiveDate) -> Option<i64> {
    if remaining_sections <= 0 {
        return None;
    }
    let days = (finish.signed_duration_since(today).num_days() + 1).max(1);
    Some(((remaining_sections + days - 1) / days).max(1))
}

/// Day index (1-based) of `today` within the plan window.
/// Returns 1 even for dates before start (we count "first day" as 1).
pub fn day_index(plan: &ReadingPlan, today: NaiveDate) -> i64 {
    let start = NaiveDate::parse_from_str(&plan.start_date, "%Y-%m-%d").unwrap_or(today);
    let delta = today.signed_duration_since(start).num_days();
    (delta + 1).max(1)
}

pub fn total_days(plan: &ReadingPlan) -> i64 {
    let start = NaiveDate::parse_from_str(&plan.start_date, "%Y-%m-%d").unwrap_or_else(|_| Utc::now().naive_utc().date());
    let end = NaiveDate::parse_from_str(&plan.target_finish_date, "%Y-%m-%d").unwrap_or(start);
    (end.signed_duration_since(start).num_days() + 1).max(1)
}

/// Index (0-based) of the section assigned for `day_idx` (1-based).
pub fn assigned_section_index(sections_count: usize, total_days: i64, day_idx: i64) -> Option<usize> {
    if sections_count == 0 || total_days <= 0 {
        return None;
    }
    let d = day_idx.clamp(1, total_days);
    // Distribute sections roughly evenly across days.
    let idx = ((d - 1) as f64 * sections_count as f64 / total_days as f64).floor() as usize;
    Some(idx.min(sections_count - 1))
}

/// How many sections *should* be completed by end of day_idx.
pub fn expected_completed(sections_count: usize, total_days: i64, day_idx: i64) -> usize {
    if sections_count == 0 || total_days <= 0 {
        return 0;
    }
    let d = day_idx.clamp(0, total_days);
    ((d as f64 * sections_count as f64 / total_days as f64).round() as usize).min(sections_count)
}

pub fn pace_state(sections_count: usize, completed: usize, total_days: i64, day_idx: i64) -> PaceState {
    if sections_count == 0 {
        return PaceState::NotStarted;
    }
    if completed >= sections_count {
        return PaceState::Done;
    }
    let expected = expected_completed(sections_count, total_days, day_idx);
    if completed >= expected {
        PaceState::OnPace
    } else {
        let deficit = expected as i64 - completed as i64;
        // 1 section behind = "behind"; >=3 sections behind = recovery
        if deficit >= 3 {
            PaceState::Recovery
        } else {
            PaceState::Behind { days_behind: deficit }
        }
    }
}

/// Forward-looking finish forecast from the OBSERVED reading rate — gentle, not
/// punitive. The caller guarantees the plan is active. Within the grace window
/// (or before any reading) it trusts the plan's own rate, so a just-started book
/// reads "on track" rather than fabricating a slip from a single missed day.
pub fn forecast(
    plan: &ReadingPlan,
    n_assignable: usize,
    completed: usize,
    act_ref: NaiveDate,
    target: NaiveDate,
    today: NaiveDate,
) -> FinishForecast {
    let remaining = (n_assignable as i64 - completed as i64).max(0);
    if remaining == 0 {
        return FinishForecast {
            state: "on_track".to_string(),
            projected_finish_date: Some(today.to_string()),
            days_late: 0,
        };
    }
    let days_since = (today.signed_duration_since(act_ref).num_days() + 1).max(1);
    let days_to_target = target.signed_duration_since(today).num_days();
    let planned_rate = plan.daily_target_units.unwrap_or(1).max(1) as f64;
    let observed_rate = completed as f64 / days_since as f64;

    // Rate used to project the finish: trust the plan within grace or with no
    // data; otherwise believe the observed rate; if activated past grace with
    // nothing read, project a token 1 section/day (honest slip, not "abandoned").
    let rate = if days_since <= GRACE_DAYS {
        planned_rate
    } else if observed_rate > 0.0 {
        observed_rate
    } else {
        1.0
    };
    let proj_days = (remaining as f64 / rate).ceil() as i64;
    let proj_finish = today + Duration::days(proj_days.max(0));
    let days_late = proj_finish.signed_duration_since(target).num_days();

    // Feasible = remaining work fits before the target at a heavy-but-sane pace.
    let remaining_target_days = days_to_target.max(0) + 1;
    let feasible = remaining as f64 <= remaining_target_days as f64 * MAX_SECTIONS_PER_DAY;

    let state = if !feasible {
        "plan_unrealistic"
    } else if days_late <= 0 {
        "on_track"
    } else if days_late <= 3 {
        "slightly_off_pace"
    } else {
        "needs_rebalance"
    };
    FinishForecast {
        state: state.to_string(),
        projected_finish_date: Some(proj_finish.to_string()),
        days_late: days_late.max(0),
    }
}

#[derive(Debug)]
pub struct PlanComputed {
    pub day_index: i64,
    pub total_days: i64,
    pub assigned_section_index: Option<usize>,
    #[allow(dead_code)]
    pub completed_count: usize,
    pub monthly_pct: i64,
    pub pace: PaceState,
    /// Present only when the plan is active and not finished; None for a
    /// plan-ready / paused / not-started / completed book.
    pub forecast: Option<FinishForecast>,
    /// Mirror of plan.status, surfaced so the UI can show plan-ready copy.
    pub plan_status: String,
}

pub fn compute(plan: &ReadingPlan, sections: &[BookSection], completed_section_ids: &[String]) -> Result<PlanComputed> {
    let today = Utc::now().naive_utc().date();
    let day_idx = day_index(plan, today);
    let total = total_days(plan);

    // Only assignable sections consume plan days. Front/back matter is still in the
    // sections list (so the reader can navigate to it), but never receives a "day N" slot.
    let assignable_indices: Vec<usize> = sections
        .iter()
        .enumerate()
        .filter(|(_, s)| s.assignable)
        .map(|(i, _)| i)
        .collect();
    let n_assignable = assignable_indices.len();

    let completed_assignable = sections
        .iter()
        .filter(|s| s.assignable && completed_section_ids.contains(&s.id))
        .count();

    let monthly_pct = if n_assignable == 0 {
        0
    } else {
        ((completed_assignable as f64 / n_assignable as f64) * 100.0).round() as i64
    };

    // Map day_idx → assignable index → original index, skipping any that are already done.
    let assigned_orig: Option<usize> = assigned_section_index(n_assignable, total, day_idx)
        .and_then(|a_idx| {
            let mut chosen = a_idx;
            while chosen < n_assignable {
                let orig = assignable_indices[chosen];
                if !completed_section_ids.contains(&sections[orig].id) {
                    return Some(orig);
                }
                chosen += 1;
            }
            None
        });

    // Plan-state-aware pace + forecast. A book is only ever "behind"/"recovery"
    // once it is ACTIVE, past the grace window, and the forecast actually slips.
    // A plan-ready (freshly imported) or paused book is never behind.
    let active = matches!(plan.status.as_str(), "active" | "rebalanced");
    let act_ref = plan
        .activated_at
        .as_deref()
        .and_then(|s| NaiveDate::parse_from_str(s.get(..10).unwrap_or(s), "%Y-%m-%d").ok())
        .unwrap_or_else(|| NaiveDate::parse_from_str(&plan.start_date, "%Y-%m-%d").unwrap_or(today));
    let target = NaiveDate::parse_from_str(&plan.target_finish_date, "%Y-%m-%d").unwrap_or(today);

    let (pace, forecast_out): (PaceState, Option<FinishForecast>) = if n_assignable == 0 {
        (PaceState::NotStarted, None)
    } else if completed_assignable >= n_assignable {
        (PaceState::Done, None)
    } else if !active {
        (PaceState::NotStarted, None)
    } else {
        let fc = forecast(plan, n_assignable, completed_assignable, act_ref, target, today);
        let pace = match fc.state.as_str() {
            "on_track" | "slightly_off_pace" => PaceState::OnPace,
            "plan_unrealistic" => PaceState::Recovery,
            _ => {
                let db = fc.days_late.max(1);
                if db >= 3 {
                    PaceState::Recovery
                } else {
                    PaceState::Behind { days_behind: db }
                }
            }
        };
        (pace, Some(fc))
    };

    Ok(PlanComputed {
        day_index: day_idx,
        total_days: total,
        assigned_section_index: assigned_orig,
        completed_count: completed_assignable,
        monthly_pct,
        pace,
        forecast: forecast_out,
        plan_status: plan.status.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    fn plan_with(status: &str, start: &str, finish: &str, daily: Option<i64>, activated: Option<&str>) -> ReadingPlan {
        ReadingPlan {
            id: "p".into(),
            book_id: "b".into(),
            start_date: start.into(),
            target_finish_date: finish.into(),
            daily_target_units: daily,
            days_per_week: 6,
            catchup_mode: "gentle".into(),
            status: status.into(),
            activated_at: activated.map(|s| s.to_string()),
            original_finish_date: None,
        }
    }

    fn secs(n: usize) -> Vec<BookSection> {
        (0..n)
            .map(|i| BookSection {
                id: format!("s{}", i),
                book_id: "b".into(),
                label: format!("S{}", i),
                href: None,
                start_locator: None,
                end_locator: None,
                estimated_units: None,
                sort_order: i as i64,
                assignable: true,
            })
            .collect()
    }

    /// PRIORITY 0: a freshly imported (plan_ready) book with zero reading must
    /// never be "behind"/"recovery", regardless of how long ago it was imported.
    #[test]
    fn fresh_import_is_never_behind() {
        let plan = plan_with("plan_ready", "2020-01-01", "2020-01-30", Some(2), None);
        let c = compute(&plan, &secs(43), &[]).unwrap();
        assert!(matches!(c.pace, PaceState::NotStarted), "fresh import must not be behind, got {:?}", c.pace);
        assert!(c.forecast.is_none(), "no forecast before activation");
        assert_eq!(c.plan_status, "plan_ready");
    }

    /// A just-activated plan (start == activation, full window) reads on track.
    #[test]
    fn forecast_on_track_when_just_activated() {
        let plan = plan_with("active", "2026-01-10", "2026-02-08", Some(2), Some("2026-01-10"));
        let f = forecast(&plan, 43, 0, d(2026, 1, 10), d(2026, 2, 8), d(2026, 1, 10));
        assert_eq!(f.state, "on_track");
        assert_eq!(f.days_late, 0);
    }

    /// A steady observed rate that comfortably finishes by target → on track.
    #[test]
    fn forecast_on_track_with_good_rate() {
        let plan = plan_with("active", "2026-01-01", "2026-01-30", Some(2), Some("2026-01-01"));
        // 20 done over 10 days = 2/day; 23 remaining → ~12 more days; finish ~1/22 ≤ 1/30.
        let f = forecast(&plan, 43, 20, d(2026, 1, 1), d(2026, 1, 30), d(2026, 1, 10));
        assert_eq!(f.state, "on_track");
    }

    /// A real, infeasible slip surfaces (and only then).
    #[test]
    fn forecast_flags_real_slip_when_stalled() {
        let plan = plan_with("active", "2026-01-01", "2026-01-12", Some(4), Some("2026-01-01"));
        // 40 remaining, target in 2 days, nothing read → cannot fit → unrealistic/rebalance.
        let f = forecast(&plan, 40, 0, d(2026, 1, 1), d(2026, 1, 12), d(2026, 1, 10));
        assert!(
            matches!(f.state.as_str(), "plan_unrealistic" | "needs_rebalance"),
            "stalled+tight plan should flag a slip, got {}",
            f.state
        );
    }

    #[test]
    fn daily_target_for_ceil_divides_and_clamps() {
        // 30 sections across 10 inclusive days → 3/day.
        assert_eq!(daily_target_for(30, d(2026, 1, 1), d(2026, 1, 10)), Some(3));
        // 31 across 10 → ceil = 4/day (never rounds down past the target).
        assert_eq!(daily_target_for(31, d(2026, 1, 1), d(2026, 1, 10)), Some(4));
        // Nothing remaining → no target.
        assert_eq!(daily_target_for(0, d(2026, 1, 1), d(2026, 1, 10)), None);
        // A single day still yields at least 1/day.
        assert_eq!(daily_target_for(5, d(2026, 1, 1), d(2026, 1, 1)), Some(5));
    }

    #[test]
    fn completed_plan_is_done() {
        let plan = plan_with("active", "2026-01-01", "2026-01-30", Some(2), Some("2026-01-01"));
        let s = secs(5);
        let done: Vec<String> = s.iter().map(|x| x.id.clone()).collect();
        let c = compute(&plan, &s, &done).unwrap();
        assert!(matches!(c.pace, PaceState::Done));
        assert!(c.forecast.is_none());
    }
}
