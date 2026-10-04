use std::collections::VecDeque;

const MAX_FIT_QUEUE: usize = 16;
const MAX_EXPORT_QUEUE: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenderLane {
    Preview,
    Fit,
    Export,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderTicket {
    pub id: u64,
    pub generation: u64,
    pub lane: RenderLane,
    pub render_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubmitResult {
    Started(RenderTicket),
    Coalesced {
        replaced_id: Option<u64>,
        pending_id: u64,
    },
    Queued {
        id: u64,
        lane: RenderLane,
    },
    Rejected {
        lane: RenderLane,
        reason: &'static str,
    },
}

#[derive(Debug, Clone)]
struct PendingRender {
    id: u64,
    lane: RenderLane,
    render_key: String,
}

#[derive(Debug, Default)]
pub struct RenderScheduler {
    next_id: u64,
    generation: u64,
    active: Option<RenderTicket>,
    newest_preview: Option<PendingRender>,
    fits: VecDeque<PendingRender>,
    exports: VecDeque<PendingRender>,
}

impl RenderScheduler {
    pub fn new(generation: u64) -> Self {
        Self {
            generation,
            ..Self::default()
        }
    }

    pub fn set_generation(&mut self, generation: u64) {
        self.generation = generation;
        self.active = None;
    }

    pub fn active(&self) -> Option<&RenderTicket> {
        self.active.as_ref()
    }

    pub fn submit(&mut self, lane: RenderLane, render_key: impl Into<String>) -> SubmitResult {
        self.next_id = self.next_id.saturating_add(1).max(1);
        let pending = PendingRender {
            id: self.next_id,
            lane,
            render_key: render_key.into(),
        };
        if self.active.is_none() {
            return SubmitResult::Started(self.start(pending));
        }

        match lane {
            RenderLane::Preview => {
                let replaced_id = self
                    .newest_preview
                    .replace(pending.clone())
                    .map(|old| old.id);
                SubmitResult::Coalesced {
                    replaced_id,
                    pending_id: pending.id,
                }
            }
            RenderLane::Fit if self.fits.len() < MAX_FIT_QUEUE => {
                self.fits.push_back(pending.clone());
                SubmitResult::Queued {
                    id: pending.id,
                    lane,
                }
            }
            RenderLane::Fit => SubmitResult::Rejected {
                lane,
                reason: "fit queue is full",
            },
            RenderLane::Export if self.exports.len() < MAX_EXPORT_QUEUE => {
                self.exports.push_back(pending.clone());
                SubmitResult::Queued {
                    id: pending.id,
                    lane,
                }
            }
            RenderLane::Export => SubmitResult::Rejected {
                lane,
                reason: "export queue is full",
            },
        }
    }

    pub fn complete(&mut self, id: u64, generation: u64) -> Option<RenderTicket> {
        let active = self.active.as_ref()?;
        if active.id != id || active.generation != generation || generation != self.generation {
            return None;
        }
        self.active = None;
        let next = self
            .exports
            .pop_front()
            .or_else(|| self.fits.pop_front())
            .or_else(|| self.newest_preview.take());
        next.map(|pending| self.start(pending))
    }

    fn start(&mut self, pending: PendingRender) -> RenderTicket {
        let ticket = RenderTicket {
            id: pending.id,
            generation: self.generation,
            lane: pending.lane,
            render_key: pending.render_key,
        };
        self.active = Some(ticket.clone());
        ticket
    }
}

#[cfg(test)]
mod tests {
    use super::{RenderLane, RenderScheduler, SubmitResult};

    #[test]
    fn preview_keeps_only_the_newest_candidate_while_compile_is_active() {
        let mut scheduler = RenderScheduler::new(4);
        let active = match scheduler.submit(RenderLane::Preview, "active") {
            SubmitResult::Started(ticket) => ticket,
            other => panic!("unexpected submit result: {other:?}"),
        };
        let first = scheduler.submit(RenderLane::Preview, "old-candidate");
        let second = scheduler.submit(RenderLane::Preview, "newest-candidate");
        assert!(matches!(
            first,
            SubmitResult::Coalesced {
                replaced_id: None,
                ..
            }
        ));
        assert!(matches!(
            second,
            SubmitResult::Coalesced {
                replaced_id: Some(_),
                ..
            }
        ));
        let next = scheduler.complete(active.id, active.generation).unwrap();
        assert_eq!(next.render_key, "newest-candidate");
        assert_eq!(next.lane, RenderLane::Preview);
    }

    #[test]
    fn frozen_exports_run_before_fit_and_preview_queues() {
        let mut scheduler = RenderScheduler::new(7);
        let active = match scheduler.submit(RenderLane::Preview, "active") {
            SubmitResult::Started(ticket) => ticket,
            other => panic!("unexpected submit result: {other:?}"),
        };
        assert!(matches!(
            scheduler.submit(RenderLane::Fit, "fit"),
            SubmitResult::Queued { .. }
        ));
        assert!(matches!(
            scheduler.submit(RenderLane::Export, "export"),
            SubmitResult::Queued { .. }
        ));
        let next = scheduler.complete(active.id, active.generation).unwrap();
        assert_eq!(next.render_key, "export");
        let next = scheduler.complete(next.id, next.generation).unwrap();
        assert_eq!(next.render_key, "fit");
    }

    #[test]
    fn stale_generation_or_out_of_order_completion_is_discarded() {
        let mut scheduler = RenderScheduler::new(2);
        let active = match scheduler.submit(RenderLane::Export, "frozen") {
            SubmitResult::Started(ticket) => ticket,
            other => panic!("unexpected submit result: {other:?}"),
        };
        assert!(scheduler.complete(active.id, 1).is_none());
        assert!(scheduler.complete(active.id + 1, 2).is_none());
        scheduler.set_generation(3);
        assert!(scheduler.complete(active.id, 2).is_none());
        let restarted = match scheduler.submit(RenderLane::Export, "recompiled") {
            SubmitResult::Started(ticket) => ticket,
            other => panic!("unexpected submit result: {other:?}"),
        };
        assert_eq!(restarted.generation, 3);
    }
}
