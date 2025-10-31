Icons for FireFlashcards

Files to include before publishing on AMO:
- icon-48.png
- icon-96.png

You can generate PNGs from the provided SVG using Inkscape or ImageMagick. If the tools are not installed on your system, install either Inkscape or ImageMagick and run one of the following:

Inkscape (recommended):
  inkscape icons/icon.svg -o icons/icon-48.png -w 48 -h 48
  inkscape icons/icon.svg -o icons/icon-96.png -w 96 -h 96

ImageMagick (fallback):
  convert -background none icons/icon.svg -resize 48x48 icons/icon-48.png
  convert -background none icons/icon.svg -resize 96x96 icons/icon-96.png

If neither tool is available, you can also export PNGs directly from a vector editor (Figma/Illustrator) at 48x48 and 96x96.
