---
kind: visual-regression-fixture
status: stable
tags:
  - visual
  - fixture
---

# Visual regression workspace

This deterministic note is the ordinary laptop surface. It contains enough structure to exercise
the editor, reading view, outline, links, properties, tags, and the navigator without depending on
network content.

Open [[01 Linked Note]] for the connected surface. The long note is [[04 Long Text]].

## Representative controls

- [ ] Keep the viewport bounded.
- [x] Preserve Markdown bytes.
- [ ] Show state with words and shapes, not colour alone.

## Recovery path

The harness places a deleted copy under `.trash/` before opening the recovery dialog.

## Image review

![[Attachments/brew-ratio-chart.png|Brew ratio chart]]

![[Attachments/brew-ratio-detail.png|Brew ratio detail]]

## Empty and error states

The fixture also contains an intentionally empty note and a note with a deliberately missing link.
