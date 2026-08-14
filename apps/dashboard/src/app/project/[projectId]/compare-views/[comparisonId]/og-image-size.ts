/**
 * Dimensions of the comparison OG image.
 *
 * Lives beside the metadata route file as a plain constant so the route file
 * can keep exporting only the component and literal route-segment options
 * (object-literal exports from a component file trip the
 * only-export-components lint). The route file imports this to size the
 * generated PNG.
 *
 * Note: Next.js only emits `og:image:width`/`og:image:height` meta tags when
 * the route file itself exports a `size` object, so those tags are omitted
 * here — crawlers read the dimensions from the 1200x630 PNG itself.
 */
export const OG_IMAGE_SIZE = { width: 1200, height: 630 } as const;
