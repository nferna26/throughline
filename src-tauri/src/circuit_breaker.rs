//! In-process circuit breaker for external integration points.
//!
//! Throughline's only external integration is the local AI server (LM Studio /
//! llama.cpp / any OpenAI-compatible endpoint). When that server hangs or
//! disappears, repeated calls cascade into a frozen UI. This breaker fails
//! fast after a threshold of recent failures, gives the server a cool-down
//! window, then probes once before flipping back to normal.
//!
//! Three states:
//!
//! - **Closed**: normal. Failures are recorded against a rolling window. If
//!   the count reaches `failure_threshold` within `window`, transition to
//!   Open.
//! - **Open**: every `check()` returns Err. After `cool_down` elapses, the
//!   next `check()` flips to HalfOpen.
//! - **HalfOpen**: `check()` returns Ok exactly once (the probe). The probe's
//!   outcome (`on_success` / `on_failure`) decides the next state — back to
//!   Closed or back to Open.
//!
//! All time math goes through a `Clock` trait so tests can drive the
//! transitions without sleeping.
//!
//! Cites: `pat-circuit-breaker` (cto-kb) → `src-book-release-it` Rule 3.

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Configuration knobs for a `Breaker`. Defaults target the desktop LM-Studio
/// case: open after 3 failures within 60 s, cool down for 30 s.
#[derive(Debug, Clone, Copy)]
pub struct BreakerConfig {
    pub failure_threshold: usize,
    pub window: Duration,
    pub cool_down: Duration,
}

impl Default for BreakerConfig {
    fn default() -> Self {
        Self {
            failure_threshold: 3,
            window: Duration::from_secs(60),
            cool_down: Duration::from_secs(30),
        }
    }
}

/// Pluggable clock so tests can advance time without sleeping.
pub trait Clock: Send + Sync {
    fn now(&self) -> Instant;
}

/// Production clock: real wall-clock `Instant::now()`.
pub struct RealClock;
impl Clock for RealClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
}

#[derive(Debug)]
enum State {
    Closed { recent_failures: Vec<Instant> },
    Open { opened_at: Instant },
    HalfOpen,
}

pub struct Breaker {
    state: Mutex<State>,
    config: BreakerConfig,
    clock: Box<dyn Clock>,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum BreakerStateKind {
    Closed,
    Open,
    HalfOpen,
}

#[derive(Debug)]
pub struct OpenError {
    pub since: Duration,
    pub cool_down_remaining: Duration,
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "circuit open — last failure {:?} ago, retry in {:?}",
            self.since, self.cool_down_remaining
        )
    }
}

impl std::error::Error for OpenError {}

impl Breaker {
    pub fn new(config: BreakerConfig) -> Self {
        Self::with_clock(config, Box::new(RealClock))
    }

    pub fn with_clock(config: BreakerConfig, clock: Box<dyn Clock>) -> Self {
        Self {
            state: Mutex::new(State::Closed {
                recent_failures: Vec::new(),
            }),
            config,
            clock,
        }
    }

    /// Check whether the breaker permits a call right now. Returns `Err(OpenError)`
    /// when the breaker is Open and cool-down hasn't elapsed. When cool-down
    /// has elapsed, transitions to HalfOpen and returns `Ok(())` (the probe).
    pub fn check(&self) -> Result<(), OpenError> {
        let now = self.clock.now();
        let mut s = self.state.lock().unwrap();
        match &*s {
            State::Closed { .. } => Ok(()),
            State::Open { opened_at } => {
                let since = now.duration_since(*opened_at);
                if since >= self.config.cool_down {
                    *s = State::HalfOpen;
                    Ok(())
                } else {
                    Err(OpenError {
                        since,
                        cool_down_remaining: self.config.cool_down - since,
                    })
                }
            }
            State::HalfOpen => Ok(()),
        }
    }

    /// Record a successful call. Transitions HalfOpen → Closed; clears the
    /// failure window in Closed.
    pub fn on_success(&self) {
        let mut s = self.state.lock().unwrap();
        *s = State::Closed {
            recent_failures: Vec::new(),
        };
    }

    /// Record a failed call. Increments the rolling window in Closed; trips
    /// to Open at the threshold. In HalfOpen, immediately back to Open.
    pub fn on_failure(&self) {
        let now = self.clock.now();
        let mut s = self.state.lock().unwrap();
        match &mut *s {
            State::Closed { recent_failures } => {
                recent_failures.retain(|t| now.duration_since(*t) < self.config.window);
                recent_failures.push(now);
                if recent_failures.len() >= self.config.failure_threshold {
                    *s = State::Open { opened_at: now };
                }
            }
            State::HalfOpen => {
                *s = State::Open { opened_at: now };
            }
            State::Open { .. } => { /* already open */ }
        }
    }

    /// Inspect current state (for diagnostics / tests).
    pub fn current_state(&self) -> BreakerStateKind {
        match &*self.state.lock().unwrap() {
            State::Closed { .. } => BreakerStateKind::Closed,
            State::Open { .. } => BreakerStateKind::Open,
            State::HalfOpen => BreakerStateKind::HalfOpen,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// Manual clock for deterministic state-transition tests.
    struct ManualClock {
        now: Mutex<Instant>,
    }
    impl ManualClock {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                now: Mutex::new(Instant::now()),
            })
        }
        fn advance(&self, d: Duration) {
            let mut t = self.now.lock().unwrap();
            *t += d;
        }
    }
    impl Clock for ManualClock {
        fn now(&self) -> Instant {
            *self.now.lock().unwrap()
        }
    }

    struct SharedClock(Arc<ManualClock>);
    impl Clock for SharedClock {
        fn now(&self) -> Instant {
            self.0.now()
        }
    }

    fn breaker(
        threshold: usize,
        window: Duration,
        cool_down: Duration,
    ) -> (Breaker, Arc<ManualClock>) {
        let clock = ManualClock::new();
        let b = Breaker::with_clock(
            BreakerConfig {
                failure_threshold: threshold,
                window,
                cool_down,
            },
            Box::new(SharedClock(clock.clone())),
        );
        (b, clock)
    }

    #[test]
    fn fresh_breaker_is_closed_and_permits_calls() {
        let (b, _c) = breaker(3, Duration::from_secs(60), Duration::from_secs(30));
        assert_eq!(b.current_state(), BreakerStateKind::Closed);
        assert!(b.check().is_ok());
    }

    #[test]
    fn opens_after_threshold_failures_inside_window() {
        let (b, _c) = breaker(3, Duration::from_secs(60), Duration::from_secs(30));
        b.on_failure();
        b.on_failure();
        assert_eq!(b.current_state(), BreakerStateKind::Closed); // still under threshold
        b.on_failure();
        assert_eq!(b.current_state(), BreakerStateKind::Open);
        // While Open, check() errors.
        let err = b.check().unwrap_err();
        assert!(err.cool_down_remaining > Duration::ZERO);
    }

    #[test]
    fn rolling_window_forgets_old_failures() {
        let (b, c) = breaker(3, Duration::from_secs(60), Duration::from_secs(30));
        b.on_failure();
        b.on_failure();
        // Two old failures slide off after the window expires.
        c.advance(Duration::from_secs(61));
        b.on_failure();
        // Only the new failure counts; we're still under threshold.
        assert_eq!(b.current_state(), BreakerStateKind::Closed);
    }

    #[test]
    fn cool_down_then_half_open_then_success_closes() {
        let (b, c) = breaker(3, Duration::from_secs(60), Duration::from_secs(30));
        b.on_failure();
        b.on_failure();
        b.on_failure();
        assert_eq!(b.current_state(), BreakerStateKind::Open);

        // Before cool-down elapses, check() still errors.
        c.advance(Duration::from_secs(29));
        assert!(b.check().is_err());

        // After cool-down, check() flips to HalfOpen and permits one probe.
        c.advance(Duration::from_secs(2));
        assert!(b.check().is_ok());
        assert_eq!(b.current_state(), BreakerStateKind::HalfOpen);

        // Probe succeeds → back to Closed.
        b.on_success();
        assert_eq!(b.current_state(), BreakerStateKind::Closed);
    }

    #[test]
    fn cool_down_then_half_open_then_failure_reopens() {
        let (b, c) = breaker(3, Duration::from_secs(60), Duration::from_secs(30));
        b.on_failure();
        b.on_failure();
        b.on_failure();
        c.advance(Duration::from_secs(31));
        assert!(b.check().is_ok());
        assert_eq!(b.current_state(), BreakerStateKind::HalfOpen);

        // Probe fails → straight back to Open. No additional failures needed.
        b.on_failure();
        assert_eq!(b.current_state(), BreakerStateKind::Open);
        assert!(b.check().is_err());
    }

    #[test]
    fn success_clears_partial_failure_window() {
        let (b, _c) = breaker(3, Duration::from_secs(60), Duration::from_secs(30));
        b.on_failure();
        b.on_failure();
        b.on_success(); // wipes the recent_failures buffer
        b.on_failure();
        assert_eq!(b.current_state(), BreakerStateKind::Closed);
    }
}
