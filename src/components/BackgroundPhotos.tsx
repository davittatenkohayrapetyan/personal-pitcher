import Image from 'next/image';

interface PhotoItem {
  src: string;
  alt: string;
}

interface PhotoPlacement {
  top?: string;
  bottom?: string;
  left?: string;
  right?: string;
  rotate: string;
  opacity: number;
  width: number;
  height: number;
}

const PLACEMENTS: PhotoPlacement[] = [
  { top: '3%', left: '1%', rotate: '-8deg', opacity: 0.10, width: 130, height: 165 },
  { top: '10%', right: '2%', rotate: '6deg', opacity: 0.08, width: 120, height: 152 },
  { top: '40%', left: '0%', rotate: '-4deg', opacity: 0.09, width: 115, height: 146 },
  { top: '55%', right: '1%', rotate: '9deg', opacity: 0.08, width: 125, height: 158 },
  { top: '72%', left: '4%', rotate: '3deg', opacity: 0.07, width: 110, height: 140 },
  { top: '28%', right: '4%', rotate: '-6deg', opacity: 0.09, width: 120, height: 152 },
  { top: '80%', right: '3%', rotate: '5deg', opacity: 0.07, width: 105, height: 133 },
  { top: '18%', left: '3%', rotate: '4deg', opacity: 0.08, width: 108, height: 137 },
];

interface BackgroundPhotosProps {
  photos: PhotoItem[];
}

export default function BackgroundPhotos({ photos }: BackgroundPhotosProps) {
  if (!photos.length) return null;

  return (
    <div aria-hidden="true" className="pointer-events-none select-none absolute inset-0 overflow-hidden">
      {photos.map((photo, i) => {
        const placement = PLACEMENTS[i % PLACEMENTS.length];
        return (
          <div
            key={photo.src}
            className="absolute"
            style={{
              top: placement.top,
              bottom: placement.bottom,
              left: placement.left,
              right: placement.right,
              opacity: placement.opacity,
              transform: `rotate(${placement.rotate})`,
              filter: 'blur(0.5px)',
              zIndex: 0,
            }}
          >
            {/* Polaroid-style frame */}
            <div
              className="bg-white shadow-2xl"
              style={{
                padding: '6px 6px 24px 6px',
                width: placement.width,
              }}
            >
              <Image
                src={photo.src}
                alt={photo.alt}
                width={placement.width - 12}
                height={placement.height - 30}
                className="block object-cover w-full"
                style={{ display: 'block' }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
