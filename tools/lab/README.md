# The lab

The extension of this checkout, on real reader pages, used the way a reader uses it. Run it before you call a change
to page finding, recognition, the panel or cards "done", and read the report.

```sh
node tools/lab/run.mjs --lab-set              # the sites marked "lab": true
node tools/lab/run.mjs --sites=name1,name2    # some sites by name
```

The site list is `tools/.cache/compat/sites.json` (shared with `tools/compat`, never committed): entries
`{ "name", "url", "follow"?, "lab"? }`. `follow` is a regular expression for a link to open first (an index page
whose chapter URL changes). Site names and URLs stay in that file: not in code, reports that are committed, commit
messages or PRs.

## What it does, per site

| step | passes when |
|---|---|
| open | the page loads (after following the `follow` link, if any) |
| found | the extension put an overlay on at least one page |
| bubbles | a bubble with recognised text is in the window (the first one is scrolled to if the reader starts below the fold) |
| text | a mouse click on the bubble shows its text in the side panel (up to `--clicks`, default 3) |
| furigana | lines with kanji have readings (– when no clicked line had kanji) |
| explanation | the panel shows an explanation (see "Explanations" below) |
| dictionary | a word click shows a dictionary entry (up to 3 words of a line are tried) |
| card | “+” on a dictionary entry adds a note with a picture to the fake AnkiConnect |
| scroll | after the next page (ArrowLeft for a reader that shows one page at a time, the mouse wheel for a long strip), a new bubble shows its text when clicked |

✓ passed, ✗ failed, – not reached or not applicable. A failed step has a note in the report.

## Output

`tools/.cache/lab/runs/<stamp>-lane<offset>[-name]/`: `report.md`, `report.json`, and screenshots per site (the page at
the first click, the panel, the page after scrolling). The report ends with the changes against this lane's previous
run. The exit code is 1 when a step that passed last time does not pass now (✓ → ✗ or ✓ → –), when the run itself
fails, or when a blocked request was attempted.

## Options

| option | |
|---|---|
| `--lab-set` | the sites with `"lab": true` |
| `--sites=a,b` | sites by name |
| `--sites-file=path` | another site list |
| `--clicks=K` | bubbles clicked per site before scrolling (default 3; up to K + 3 while no line had kanji or a dictionary word) |
| `--grant-all` | grant `<all_urls>`, as after every “Allow …” button (image hosts, screenshots); default: the sites' origins only, as after “Enable on this site” |
| `--llm=stub` | (default) a fixed explanation, no model is asked |
| `--llm=replay` | explanations from the cache of earlier live runs; a miss falls back to the stub and is counted |
| `--llm=live:N` | up to N real requests with your own DeepSeek key from `ANKI_MANGA_DEEPSEEK_KEY`; answers go to the cache |
| `--headful` | a visible browser, left open at the end until Enter |
| `--profile=fresh` | a new browser profile (default `keep`: the models stay cached between runs) |
| `--real-download` | models from their real host instead of the local mirror (`tools/.cache/mirror`) |
| `--out=name` | a suffix for the run folder |

## Explanations

The extension runs in own-key mode with a placeholder key. Its requests to the provider are answered by the lab
(`tools/lab/llm.mjs`), so the key in the profile is never real. In `live:N` mode the lab makes the request itself from
node with the key from the environment; the key is not written anywhere. The cache is
`tools/.cache/lab/llm-cache.json`, keyed by the prompt version and the line.

## Safety

- AnkiConnect (port 8765) is never reached: the panel's requests are redirected to a fake that records the notes.
- The free-tier server is never called: requests to it are blocked, and the run fails.
- Page images stay on the machine, as in the product.

## Two lanes at once

Ports (`ANKI_MANGA_PORT_OFFSET`, see `tools/ports.mjs`) and the profile and extension copy
(`tools/.cache/lab/lane-<offset>/`) are per lane, so lanes A and B can run the lab at the same time. The explanation
cache is shared.

## Tests

`node --test tools/lab/lab.test.mjs` covers the pure parts (option parsing, the explanation source, the report and
the diff).

## Debugging a site

`LAB_DEBUG=1` prints the page's, the service worker's and the engine's console messages and the page facts to
stderr. They can contain site URLs: keep them out of anything committed.
