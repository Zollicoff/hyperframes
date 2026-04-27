---
name: remotion-to-hyperframes
description: Translate a Remotion (React-based) video composition into a HyperFrames HTML composition. Use when (1) the user provides Remotion source (`.tsx` files using `useCurrentFrame`, `Sequence`, `AbsoluteFill`, `interpolate`, `spring`, `staticFile`, etc.) and asks to port, convert, or migrate it to HyperFrames; (2) the user pastes a Remotion entry point (`Root.tsx`, `Composition`) and wants HTML; (3) the user links a Remotion repo and asks for the HyperFrames equivalent; (4) the user says "port my Remotion project", "translate this Remotion code", "rewrite as HTML", or "I have a Remotion comp, make it HyperFrames". Skill detects unsupported patterns (useState, useEffect with side effects, async calculateMetadata, third-party React component libraries, `@remotion/lambda` features) and recommends the runtime interop escape hatch instead of attempting a lossy translation.
---

# Remotion to HyperFrames

## Overview

Translate Remotion (React-based) video compositions into HyperFrames (HTML + GSAP) compositions. Most Remotion idioms have direct HyperFrames equivalents — the translation is mechanical for ~80% of typical compositions. This skill encodes the mapping and guards against the lossy 20%.

## Workflow

1. **Lint the source.** Run the source-lint script against the Remotion project to surface any patterns that can't translate cleanly (React state hooks, async metadata, third-party React components). If the source uses any blocker pattern, recommend the runtime interop escape hatch (PR #214 pattern) instead of attempting a translation.

2. **Scaffold the translation.** Generate a HyperFrames HTML skeleton from the Remotion source — `Composition` props become `data-*` attributes on the root `#stage` div, `<Sequence>` wrappers become elements with `data-start` / `data-duration` / `data-track-index`, `<AbsoluteFill>` becomes `<div style="position:absolute;inset:0">`. Leave timing-sensitive and easing-sensitive sections marked for refinement.

3. **Refine timing and easing.** Convert each `useCurrentFrame`-driven `interpolate` / `spring` call into an equivalent paused GSAP tween on the composition timeline. This is the part where translation correctness matters most — easing curves and stagger timing are what readers notice.

4. **Validate by frame-diff.** Render both the original Remotion composition and the translated HyperFrames composition, then compute per-frame SSIM. Threshold-based pass/fail tells the user which scenes are visually correct and which need another pass.

5. **Document the gaps.** Any Remotion features that didn't translate (custom React subcomponents requiring manual rewrite, library transitions without a HyperFrames equivalent, etc.) get listed in a `TRANSLATION_NOTES.md` next to the output so the user can finish them or decide to use the runtime interop instead.

## What this skill explicitly does NOT do

- **Translate React state machines.** Remotion compositions that drive animation via `useState` + `useEffect` are not deterministic frame-capture targets in HyperFrames' model; recommend the runtime interop escape hatch.
- **Translate `@remotion/lambda` configuration.** HyperFrames is single-machine today; Lambda-specific code drops with a note.
- **Run Remotion's render pipeline alongside HyperFrames.** That's the runtime interop pattern from [PR #214](https://github.com/heygen-com/hyperframes/pull/214) — a separate problem with a separate (and existing) solution.

## Status

Skill scaffold landed; eval harness, test corpus, and translation references are added in subsequent PRs in the stack. Until then, this skill should bow out and recommend the user hand-translate or use the runtime interop pattern.
