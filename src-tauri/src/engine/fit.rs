//! Bounded one-page search. Every accepted layout has a real frozen compile.
use std::collections::HashSet;
use std::time::{Duration, Instant};

use super::{render_paged_with_resources, AvatarAsset, EngineError, RenderFontBytes};
use crate::domain::{FitAttempt, FitPlan, FitStatus, Presentation, ResumeDocument};

pub const MAX_CANDIDATES: usize = 16;
pub const FIT_TIMEOUT: Duration = Duration::from_secs(8);
pub const MIN_FONT_SIZE_PT: f32 = 9.0;
pub const MIN_HEADING_SIZE_PT: f32 = 9.75;
pub const MIN_PAGE_MARGIN_PT: f32 = 18.0;

pub fn semantic_hash(document: &ResumeDocument) -> Result<String, EngineError> {
    let mut value = serde_json::to_value(document)
        .map_err(|error| EngineError::Validation(error.to_string()))?;
    value
        .as_object_mut()
        .ok_or_else(|| EngineError::Validation("Document is not an object".into()))?
        .remove("presentation");
    crate::domain::canonical_hash(&value).map_err(|error| EngineError::Validation(error.message))
}

fn readable(presentation: &Presentation) -> bool {
    [
        presentation.font_size_pt,
        presentation.line_height_pt,
        presentation.heading_size_pt,
        presentation.page_margin_pt,
        presentation.module_gap_pt,
        presentation.paragraph_gap_pt,
        presentation.list_gap_pt,
    ]
    .iter()
    .all(|value| value.is_finite())
        && presentation.font_size_pt >= MIN_FONT_SIZE_PT
        && presentation.line_height_pt >= presentation.font_size_pt
        && presentation.heading_size_pt >= MIN_HEADING_SIZE_PT
        && presentation.page_margin_pt >= MIN_PAGE_MARGIN_PT
        && presentation.module_gap_pt >= 0.0
        && presentation.paragraph_gap_pt >= 0.0
        && presentation.list_gap_pt >= 0.0
}

fn candidates(original: &Presentation) -> Vec<Presentation> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for step in [0.0, 1.0 / 3.0, 2.0 / 3.0, 1.0] {
        for spacing in [1.0, 0.9, 0.8, 0.7] {
            let mut value = original.clone();
            value.font_size_pt =
                original.font_size_pt + (MIN_FONT_SIZE_PT - original.font_size_pt) * step;
            let ratio = value.font_size_pt / original.font_size_pt;
            value.line_height_pt =
                (original.line_height_pt * ratio * spacing).max(value.font_size_pt);
            value.heading_size_pt = (original.heading_size_pt * ratio).max(MIN_HEADING_SIZE_PT);
            value.page_margin_pt = (original.page_margin_pt * spacing).max(MIN_PAGE_MARGIN_PT);
            value.module_gap_pt *= spacing;
            value.paragraph_gap_pt *= spacing;
            value.list_gap_pt *= spacing;
            let key = serde_json::to_string(&value).expect("finite candidate presentation");
            if seen.insert(key) {
                result.push(value);
            }
        }
    }
    result
}

/// Validate a worker proposal against the exact frozen source before exposing it.
pub fn validate_plan(document: &ResumeDocument, plan: &FitPlan) -> Result<(), EngineError> {
    let invalid = || {
        EngineError::Validation("Fit plan does not match frozen input or candidate policy".into())
    };
    if plan.semantic_hash != semantic_hash(document)?
        || plan.original_presentation != document.presentation
        || plan.attempts.len() > MAX_CANDIDATES
        || plan.attempts.iter().enumerate().any(|(index, attempt)| {
            attempt.candidate_index as usize != index
                || attempt.page_count == 0
                || attempt.page_count > 200
        })
    {
        return Err(invalid());
    }
    if !readable(&document.presentation) {
        return if plan.status == FitStatus::Unreadable
            && plan.attempts.is_empty()
            && plan.fitted_presentation.is_none()
        {
            Ok(())
        } else {
            Err(invalid())
        };
    }
    let options = candidates(&document.presentation);
    if plan.attempts.len() > options.len() {
        return Err(invalid());
    }
    match plan.status {
        FitStatus::Fitted | FitStatus::AlreadyFits => {
            let last = plan.attempts.last().ok_or_else(invalid)?;
            let fitted = plan.fitted_presentation.as_ref().ok_or_else(invalid)?;
            if last.page_count != 1
                || !readable(fitted)
                || options.get(last.candidate_index as usize) != Some(fitted)
                || (plan.status == FitStatus::AlreadyFits) != (*fitted == document.presentation)
                || plan.attempts[..plan.attempts.len() - 1]
                    .iter()
                    .any(|attempt| attempt.page_count == 1)
            {
                return Err(invalid());
            }
        }
        FitStatus::NoFit => {
            if !readable(&document.presentation)
                || plan.fitted_presentation.is_some()
                || plan.attempts.len() != options.len().min(MAX_CANDIDATES)
                || plan.attempts.iter().any(|attempt| attempt.page_count == 1)
            {
                return Err(invalid());
            }
        }
        FitStatus::Unreadable => {
            if readable(&document.presentation)
                || !plan.attempts.is_empty()
                || plan.fitted_presentation.is_some()
            {
                return Err(invalid());
            }
        }
        FitStatus::Cancelled | FitStatus::TimedOut => {
            if plan.fitted_presentation.is_some() {
                return Err(invalid());
            }
        }
    }
    Ok(())
}

fn search(
    document: &ResumeDocument,
    deadline: Instant,
    mut cancelled: impl FnMut() -> bool,
    mut compile: impl FnMut(&ResumeDocument) -> Result<usize, EngineError>,
) -> Result<FitPlan, EngineError> {
    let mut plan = FitPlan {
        status: FitStatus::NoFit,
        semantic_hash: semantic_hash(document)?,
        original_presentation: document.presentation.clone(),
        fitted_presentation: None,
        attempts: Vec::new(),
    };
    if !readable(&document.presentation) {
        plan.status = FitStatus::Unreadable;
        return Ok(plan);
    }
    for (index, presentation) in candidates(&document.presentation)
        .into_iter()
        .take(MAX_CANDIDATES)
        .enumerate()
    {
        if cancelled() {
            plan.status = FitStatus::Cancelled;
            return Ok(plan);
        }
        if Instant::now() >= deadline {
            plan.status = FitStatus::TimedOut;
            return Ok(plan);
        }
        let mut candidate = document.clone();
        candidate.presentation = presentation;
        let page_count = compile(&candidate)?;
        if page_count == 0 {
            return Err(EngineError::Compile(
                "Fit candidate compiled without pages".into(),
            ));
        }
        plan.attempts.push(FitAttempt {
            candidate_index: index as u8,
            page_count: page_count as u32,
        });
        if cancelled() {
            plan.status = FitStatus::Cancelled;
            return Ok(plan);
        }
        if Instant::now() >= deadline {
            plan.status = FitStatus::TimedOut;
            return Ok(plan);
        }
        if page_count == 1 {
            plan.status = if candidate.presentation == document.presentation {
                FitStatus::AlreadyFits
            } else {
                FitStatus::Fitted
            };
            plan.fitted_presentation = Some(candidate.presentation);
            return Ok(plan);
        }
    }
    Ok(plan)
}

/// Cancellation and elapsed time are checked before/after each compile. The
/// worker supervisor must additionally enforce the independent hard deadline.
pub fn solve_one_page(
    document: &ResumeDocument,
    avatar: AvatarAsset,
    fonts: &RenderFontBytes,
    reference_date: (i32, u8, u8),
    cancelled: impl FnMut() -> bool,
) -> Result<FitPlan, EngineError> {
    search(
        document,
        Instant::now() + FIT_TIMEOUT,
        cancelled,
        |candidate| {
            render_paged_with_resources(candidate, avatar.clone(), fonts, reference_date)
                .map(|paged| paged.pages().len())
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{Inline, RichBlock, Section};

    fn document(repetitions: usize) -> ResumeDocument {
        let mut document = crate::engine::tests::sample_document();
        document.presentation.font_size_pt = 11.0;
        document.presentation.line_height_pt = 14.25;
        if let Section::Summary(section) = &mut document.sections[2] {
            section.body = vec![RichBlock::Paragraph {
                children: vec![Inline::Link {
                    href: "https://example.invalid/frozen-fit".into(),
                    children: vec![Inline::Text {
                        text: "有限候选不改变正文顺序。".repeat(repetitions),
                        marks: vec![],
                    }],
                }],
            }];
        }
        document
    }

    fn real_fit(document: &ResumeDocument) -> FitPlan {
        solve_one_page(
            document,
            None,
            &RenderFontBytes::default(),
            super::super::DEFAULT_REFERENCE_DATE,
            || false,
        )
        .unwrap()
    }

    #[test]
    fn real_fit_is_one_page_preserves_all_nonlayout_data_and_is_idempotent() {
        let source = document(190);
        let before = source.clone();
        let fonts = RenderFontBytes::default();
        assert_eq!(
            render_paged_with_resources(
                &source,
                None,
                &fonts,
                super::super::DEFAULT_REFERENCE_DATE
            )
            .unwrap()
            .pages()
            .len(),
            2
        );
        let plan = real_fit(&source);
        assert_eq!(plan.status, FitStatus::Fitted);
        assert!(plan.attempts.len() <= MAX_CANDIDATES);
        assert_eq!(source, before);
        let mut fitted = source.clone();
        fitted.presentation = plan.fitted_presentation.clone().unwrap();
        assert!(readable(&fitted.presentation));
        assert_eq!(semantic_hash(&fitted).unwrap(), plan.semantic_hash);
        assert_eq!(fitted.sections, source.sections);
        assert_eq!(fitted.basic, source.basic);
        assert_eq!(
            render_paged_with_resources(
                &fitted,
                None,
                &fonts,
                super::super::DEFAULT_REFERENCE_DATE
            )
            .unwrap()
            .pages()
            .len(),
            1
        );
        let again = real_fit(&fitted);
        assert_eq!(again.status, FitStatus::AlreadyFits);
        assert_eq!(again.attempts.len(), 1);
        assert_eq!(again.fitted_presentation, Some(fitted.presentation));
    }

    #[test]
    fn unfit_long_link_uses_bounded_real_compiles_and_leaves_original_layout() {
        let mut source = document(650);
        source.presentation.font_size_pt = 14.0;
        source.presentation.line_height_pt = 18.0;
        source.presentation.heading_size_pt = 16.0;
        source.presentation.page_margin_pt = 30.0;
        source.presentation.module_gap_pt = 4.0;
        source.presentation.paragraph_gap_pt = 2.0;
        source.presentation.list_gap_pt = 2.0;
        let before = source.clone();
        // This test exhausts real candidates independently of the production
        // deadline, which is covered by the cancellation/timeout test below.
        // Concurrent debug builds can take longer than the production budget.
        let fonts = RenderFontBytes::default();
        let plan = search(
            &source,
            Instant::now() + Duration::from_secs(60),
            || false,
            |candidate| {
                render_paged_with_resources(
                    candidate,
                    None,
                    &fonts,
                    super::super::DEFAULT_REFERENCE_DATE,
                )
                .map(|result| result.pages().len())
            },
        )
        .unwrap();
        assert_eq!(plan.status, FitStatus::NoFit);
        assert_eq!(plan.attempts.len(), MAX_CANDIDATES);
        assert!(plan.attempts.iter().all(|attempt| attempt.page_count > 1));
        assert_eq!(plan.fitted_presentation, None);
        assert_eq!(plan.original_presentation, source.presentation);
        assert_eq!(source, before);
    }

    #[test]
    fn nonmonotonic_page_counts_are_checked_without_binary_estimates() {
        let source = document(10);
        let mut counts = [2, 4, 3, 1].into_iter();
        let plan = search(
            &source,
            Instant::now() + FIT_TIMEOUT,
            || false,
            |_| Ok(counts.next().unwrap()),
        )
        .unwrap();
        assert_eq!(plan.status, FitStatus::Fitted);
        assert_eq!(
            plan.attempts
                .iter()
                .map(|attempt| attempt.page_count)
                .collect::<Vec<_>>(),
            vec![2, 4, 3, 1]
        );
    }

    #[test]
    fn worker_plan_rejects_changed_source_unbounded_search_and_forged_layout() {
        let source = document(10);
        let plan = search(&source, Instant::now() + FIT_TIMEOUT, || false, |_| Ok(1)).unwrap();
        validate_plan(&source, &plan).unwrap();
        let mut changed_source = source.clone();
        changed_source.basic.name.push('X');
        assert!(validate_plan(&changed_source, &plan).is_err());
        let mut forged = plan.clone();
        forged.fitted_presentation.as_mut().unwrap().page_margin_pt += 1.0;
        assert!(validate_plan(&source, &forged).is_err());
        let mut forged = plan.clone();
        forged.attempts[0].candidate_index = 15;
        assert!(validate_plan(&source, &forged).is_err());
        let mut forged = plan.clone();
        forged.status = FitStatus::NoFit;
        forged.fitted_presentation = None;
        assert!(validate_plan(&source, &forged).is_err());
        let mut forged = plan.clone();
        forged.attempts = vec![plan.attempts[0].clone(); MAX_CANDIDATES + 1];
        assert!(validate_plan(&source, &forged).is_err());
        let mut unreadable = source;
        unreadable.presentation.font_size_pt = 8.0;
        let plan = search(
            &unreadable,
            Instant::now() + FIT_TIMEOUT,
            || false,
            |_| panic!("unreadable source compiled"),
        )
        .unwrap();
        validate_plan(&unreadable, &plan).unwrap();
    }

    #[test]
    fn cancellation_and_elapsed_compile_discard_a_successful_candidate() {
        use std::cell::Cell;
        let source = document(10);
        let stopped = Cell::new(false);
        let plan = search(
            &source,
            Instant::now() + FIT_TIMEOUT,
            || stopped.get(),
            |_| {
                stopped.set(true);
                Ok(1)
            },
        )
        .unwrap();
        assert_eq!(plan.status, FitStatus::Cancelled);
        assert_eq!(plan.fitted_presentation, None);
        assert_eq!(plan.original_presentation, source.presentation);
        let plan = search(
            &source,
            Instant::now() - Duration::from_millis(1),
            || false,
            |_| panic!("expired search must not compile"),
        )
        .unwrap();
        assert_eq!(plan.status, FitStatus::TimedOut);
        assert!(plan.attempts.is_empty());
        let deadline = Instant::now() + Duration::from_millis(2);
        let plan = search(
            &source,
            deadline,
            || false,
            |_| {
                std::thread::sleep(Duration::from_millis(5));
                Ok(1)
            },
        )
        .unwrap();
        assert_eq!(plan.status, FitStatus::TimedOut);
        assert_eq!(plan.fitted_presentation, None);
    }

    #[test]
    fn unreadable_original_is_not_silently_shrunk_further() {
        let mut source = document(10);
        source.presentation.font_size_pt = MIN_FONT_SIZE_PT - 0.01;
        let before = source.clone();
        let plan = search(
            &source,
            Instant::now() + FIT_TIMEOUT,
            || false,
            |_| panic!("unreadable input must not compile"),
        )
        .unwrap();
        assert_eq!(plan.status, FitStatus::Unreadable);
        assert!(plan.attempts.is_empty());
        assert_eq!(plan.fitted_presentation, None);
        assert_eq!(source, before);
    }

    #[test]
    fn compile_errors_return_without_a_layout_proposal() {
        let source = document(10);
        let before = source.clone();
        assert!(search(
            &source,
            Instant::now() + FIT_TIMEOUT,
            || false,
            |_| Err(EngineError::Compile("synthetic font rejection".into()))
        )
        .is_err());
        assert_eq!(source, before);
    }
}
