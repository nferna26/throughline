use anyhow::Result;
use chrono::{Duration, NaiveDate, Utc};
use uuid::Uuid;

use crate::models::{BookSection, PaceState, ReadingPlan};

pub const DEFAULT_DAYS: i64 = 30;

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
    }
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

#[derive(Debug)]
pub struct PlanComputed {
    pub day_index: i64,
    pub total_days: i64,
    pub assigned_section_index: Option<usize>,
    #[allow(dead_code)]
    pub completed_count: usize,
    pub monthly_pct: i64,
    pub pace: PaceState,
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

    let pace = pace_state(n_assignable, completed_assignable, total, day_idx);
    Ok(PlanComputed {
        day_index: day_idx,
        total_days: total,
        assigned_section_index: assigned_orig,
        completed_count: completed_assignable,
        monthly_pct,
        pace,
    })
}
