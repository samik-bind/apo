# Inter static instances (for the OG image generator)

These are static instances of Inter, instantiated from the upstream variable font
and used by `src/pages/og-landing.png.ts` (the Open Graph image for the docs
landing page).

## Why static, not the variable font

`satori` parses fonts with `@shuding/opentype.js`, whose `parseFvarAxis` throws
`Cannot read properties of undefined (reading '256')` on any font that carries an
`fvar` (variation axes) table. `fonttools varLib.instancer` bakes axis values into
glyphs but **keeps the `fvar` table**, so instantiated instances still crash satori.
The variation tables must be stripped after instantiation.

## Regenerating (e.g. when Inter updates)

Requires `uv` (already on PATH in this repo) for `fonttools`:

```bash
# 1. Fetch the upstream variable font (OFL licensed).
curl -sL -o Inter-Variable.ttf \
  "https://github.com/google/fonts/raw/refs/heads/main/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf"

# 2. Instantiate each weight and strip the variation tables satori can't parse.
uv run --with fonttools python -c "
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.ttLib import TTFont
import os
VAR_TABLES = ('fvar','gvar','STAT','HVAR','MVAR','VVAR','avar','cvar','DSIG')
for w in (400, 500, 600, 700):
    f = TTFont('Inter-Variable.ttf')
    instantiateVariableFont(f, {'wght': w}, inplace=True)
    for t in VAR_TABLES:
        if t in f:
            del f[t]
    f.save(f'Inter-{w}.ttf')
    print(f'Inter-{w}.ttf', os.path.getsize(f'Inter-{w}.ttf'), 'has fvar:', 'fvar' in f)
"

# 3. Clean up the variable font — satori can't use it.
rm Inter-Variable.ttf
```

License: Inter is released under the SIL Open Font License 1.1.
