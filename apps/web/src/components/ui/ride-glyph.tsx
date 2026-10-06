import { colourForRide, outlineFor, type Outline } from '@/components/ui/map-symbols';

const toPoints = (outline: Outline): string => outline.map(([x, y]) => `${x},${y}`).join(' ');

type GlyphProps = {
  /** Sits beside its own name in a legend, so the shape never has to be guessed. */
  noun: string;
  taken?: boolean;
  className?: string;
};

/**
 * The same outline as SVG, for the full map's markers and for both legends. The
 * viewBox leaves room for the stroke, which `vector-effect` holds at one screen
 * pixel however small the glyph is drawn: scaled with the viewBox it would
 * vanish in a legend row and swamp a 20 px marker.
 */
export const RideGlyph = ({ noun, taken = false, className }: GlyphProps) => (
  <svg viewBox="-1.2 -1.2 2.4 2.4" aria-hidden="true" className={className}>
    <polygon
      points={toPoints(outlineFor(noun))}
      fill={taken ? 'none' : colourForRide(noun)}
      stroke={colourForRide(noun)}
      strokeWidth={taken ? 1.6 : 0}
      strokeLinejoin="round"
      vectorEffect="non-scaling-stroke"
    />
  </svg>
);
