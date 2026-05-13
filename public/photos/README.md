# Photos

Place your personal photos in this folder. They will be automatically scattered in the background of the site with decorative opacity.

## Supported formats
- `.jpg` / `.jpeg`
- `.png`
- `.webp`
- `.svg`

## How it works

The `BackgroundPhotos` component (`src/components/BackgroundPhotos.tsx`) reads from a static list of photo paths and renders them scattered across the hero section background using absolute positioning, low opacity (5–10%), and slight rotations — giving the page a personal touch without distracting from the content.

## Adding your photos

1. Drop your photos into this folder (e.g. `public/photos/my-photo.jpg`).
2. Update the `HERO_PHOTOS` array in `src/components/HeroSection.tsx` to include your new photo paths:

```ts
const HERO_PHOTOS = [
  { src: '/photos/my-photo.jpg', alt: 'Descriptive alt text' },
  // ...
];
```

## Placeholder photos

The SVG files in this folder (`hiking.svg`, `chess.svg`, `coding.svg`, `speaking.svg`, `photography.svg`, `coffee.svg`, `reading.svg`) are illustrative placeholders representing Davit's interests. Replace them with real photographs for the best result.
