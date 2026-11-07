# STARHAND pitch deck

The deck for in-person judging: 3 minutes of pitch and live demo, then 2 minutes of questions.

| File | What it is |
| --- | --- |
| `STARHAND.pptx` | The deck: 10 main slides and 2 backup screenshot slides, 16:9, with presenter notes |
| `STARHAND.pdf` | The same deck as a PDF, with its fonts embedded |
| `build_deck.py` | The python-pptx script that generates both |
| `SPEAKER-NOTES.md` | About 2:50 of spoken lines, the run of show and answers to likely questions. The build copies the lines into the presenter notes. |
| `screenshots/` | Screenshots for the deck |

## Rebuild

Run one of these from the repository root:

```bash
uv run slides/build_deck.py --pdf      # uv installs python-pptx 1.0.2 for this run
python3 slides/build_deck.py --pdf     # if python-pptx 1.0.2 is already installed
```

`--pdf` exports `STARHAND.pdf` with LibreOffice. It uses a private LibreOffice profile, so an open LibreOffice window cannot block the export. To export by hand instead, close LibreOffice first, then run:

```bash
soffice --headless --convert-to pdf --outdir slides slides/STARHAND.pptx
```

The build lists which screenshots it found. When a text box looks too small for its text, it also prints a `fit warning:` line; check that slide in the PDF.

To preview the slides as images:

```bash
pdftoppm -png -r 50 slides/STARHAND.pdf /tmp/deck/s
```

## Add the screenshots

Save each screenshot in `slides/screenshots/`, then rebuild. PNG or JPG both work.

| File | Slide | What to capture |
| --- | --- | --- |
| `bay.png` | 4, Live demo | The bay view, with the arm and the samples |
| `teleop.png` | 11, backup | The hand pane next to the bay, mid-carry |
| `fabricator.png` | 12, backup | A Fabricator result card, such as the Iron meteorite |

- **A 16:9 screenshot** fills its slide edge to edge. Take it in Chrome at a 16:9 size, such as 1920×1080, with `?present=1`. A screenshot close to 16:9, such as 16:10, is cropped from the centre.
- **Any other shape**, such as a cropped result card, is shown whole under the slide title. It is never stretched.
- **A missing screenshot** gets a placeholder that names its file path.

Slides 11 and 12 come after "Thank you", so the live run never has to skip them. Use them if the live demo fails or to answer questions.

## Before judging

- [ ] In `build_deck.py`, fill in `LINKS`: the live URL and the video. Links that still start with `<` are drawn in amber.
- [ ] Check the measured facts near the top of `build_deck.py`: `LIMITS`, `SCALED`, `REFUSED`, `BENNU` and `ARM`. Slide 5 shows the mass limit as ≤ 90 g, the arm's payload. Change any number the app no longer shows.
- [ ] Add the three screenshots.
- [ ] Rebuild with `--pdf`, then page through the PDF.
- [ ] Rehearse `SPEAKER-NOTES.md` with a timer.

## Fonts

The deck uses Inter for text and JetBrains Mono for numbers and labels. Both use the SIL Open Font License.

- **The PDF** embeds both fonts and looks the same on every machine. Present from the PDF.
- **The .pptx** looks right only where both fonts are installed. Elsewhere, PowerPoint substitutes other fonts. Use the .pptx when you want presenter notes on your own laptop.

## How the deck is drawn

Every slide is built from python-pptx shapes, so the deck needs no image files besides the screenshots.

- **Asteroid silhouettes** are traced at build time from the NASA shape models in `public/assets/samples/`. If those files are missing, the build draws a placeholder outline instead.
- **Colours, fonts and measured facts** are at the top of `build_deck.py`.
- **Each slide** has its own function, from `s1_title` to `s10_thanks`. `screenshot_slide` builds slides 4, 11 and 12.
- **Presenter notes** come from the `### Slide N` sections of `SPEAKER-NOTES.md`.
