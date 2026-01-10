#!/bin/bash

SVG="public/icon.svg"

if [ ! -f "$SVG" ]; then
  echo "Error: $SVG not found!"
  exit 1
fi

SIZES=(16 32 48 128)

for SIZE in "${SIZES[@]}"; do
  # Use 'magick' if available, otherwise 'convert' (older ImageMagick)
  if command -v magick &> /dev/null; then
    magick -background none "$SVG" -resize "${SIZE}x${SIZE}" "public/icon${SIZE}.png"
  else
    convert -background none "$SVG" -resize "${SIZE}x${SIZE}" "public/icon${SIZE}.png"
  fi
  echo "Generated public/icon${SIZE}.png"
done
