# Screenshots to capture

Drop the PNGs in this directory using exactly these filenames — the README table
already points at them, so the images appear the moment the files exist.

Run the seeded demo first (`npm run prisma:seed` in `apps/api`), which creates a
demo tenant with bilingual documents already embedded, so every screen has real
content rather than an empty state.

| Filename | What to capture |
|---|---|
| `01-documents.png` | The documents list, showing at least one `READY`, one `PROCESSING` with its live status, and one `FAILED` with the human-readable reason. The mixed state is the point — it shows ingestion is a real pipeline, not an upload form. |
| `02-playground.png` | The test console mid-answer, with the response streaming and the source chips visible underneath. Capture while tokens are still arriving if you can. |
| `03-bilingual.png` | **The money shot.** A Sinhala question answered in Sinhala from an English source document, with the source chip showing the English filename. This one image is the whole product. |
| `04-citations.png` | An answer with inline `[1]`, `[2]` markers and the matching source cards expanded to show the retrieved passage and its page number. |
| `05-refusal.png` | A question with no answer in the corpus — "Who won the 1996 cricket World Cup?" — refused rather than guessed. The similarity floor doing its job. |
| `06-unanswered.png` | The unanswered-questions report: the gaps in a customer's documents, which is the feature that makes the product keep earning its subscription. |
| `07-widget.png` | The embeddable widget open on a plain customer web page, so the Shadow DOM isolation and the 14KB footprint have a visible context. |
| `08-usage.png` | The usage and quota screen — questions asked, documents indexed, quota remaining for the month. |
| `09-swagger.png` | Swagger at `/docs` with the route list expanded, showing the documented API surface. |
| `10-mobile-widget.png` | The widget on a phone-width viewport, to show it is usable on the device most Sri Lankan users will actually open it on. |

Keep them at a sensible width (1400–1600px is plenty) and crop out browser
chrome, bookmarks bars and any personal tabs.

**Before committing any screenshot:** check it contains no real API key, no
`.env` contents, no email address other than a demo one, and no customer
document you do not own.
