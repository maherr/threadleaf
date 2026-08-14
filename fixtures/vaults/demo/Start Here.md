---
tags:
  - meta
kind: guide
---

# Start Here

This is Threadleaf's demo vault. It is small, invented, and brand neutral: a hobbyist's notes on
home coffee brewing, built only to show how an ordinary Markdown vault looks and behaves inside
Threadleaf. Nothing here is a real person, a real company, or a real brand.

## What this vault demonstrates

- **Wikilinks and backlinks.** Every brewing method links to [[Brewing/Grind Size Guide]], and that
  note collects the backlinks in return. Open it and check the backlinks panel.
- **Headings and anchors.** Other notes link to specific sections of
  [[Brewing/Grind Size Guide]] and [[Glossary/Extraction]], for example
  [[Brewing/Grind Size Guide#Espresso]].
- **Tags.** Frontmatter tags such as `beans` and `equipment`, plus inline tags such as `#brew-log`
  across the [[Journal/2026-08-10|daily journal notes]].
- **Properties and frontmatter.** The three notes under `Beans/`, starting with
  [[Beans/Ethiopia Yirgacheffe]], carry typed properties: text, a list, a number, a checkbox, and a
  date.
- **Tasks.** [[Projects/Dial In New Bean Checklist]] and [[Projects/Equipment Wishlist]] both use
  Markdown checkboxes, including one custom status.
- **A daily note.** [[Journal/2026-08-10]], [[Journal/2026-08-11]], and [[Journal/2026-08-12]] are
  an ordinary three-day run of daily notes under `Journal/`.
- **A transclusion.** [[Brewing/Espresso Ratios]] embeds a section of [[Glossary/Extraction]]
  directly, and this note embeds a section of [[Brewing/Grind Size Guide]] below.
- **An attachment.** [[Brewing/Espresso Ratios]] also embeds a small chart from `Attachments/`.
- **Unicode.** [[Glossary/Vocabulaire du café]] is written in French with ordinary accented
  characters. [[Journal/2026-08-12]] adds a short aside in Unicode content outside plain ASCII,
  including a multi-code-point emoji sequence, to exercise grapheme-aware word and character
  counting.

## See it in action

The section below is transcluded, not copied, from [[Brewing/Grind Size Guide]]:

![[Brewing/Grind Size Guide#Espresso]]

## A small note on the Unicode content

Two short technical asides, for anyone checking character handling rather than coffee:

- "café" appears in this vault in two different byte forms that look identical: once as
  a single composed character (`é`, U+00E9) here and in [[Glossary/Vocabulaire du café]], and once
  in [[Journal/2026-08-12]] as a plain `e` followed by a separate combining acute accent mark
  (U+0065 U+0301). Both spellings are the letter e with an acute accent; only the encoding differs.
- [[Journal/2026-08-12]] also includes 🧑‍🌾, which is not one character but three code
  points (U+1F9D1, a zero-width joiner U+200D, and U+1F33E) joined into a single visible grapheme,
  and 🫘, a single code point above the Basic Multilingual Plane. Both are astral-plane
  Unicode.
