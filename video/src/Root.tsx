import React from 'react';
import { Composition } from 'remotion';
import { video } from './brand';
import { Showcase, SHOWCASE_DURATION } from './compositions/Showcase';
import { Guide, GUIDE_DURATION } from './compositions/Guide';

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="Showcase"
      component={Showcase}
      durationInFrames={SHOWCASE_DURATION}
      fps={video.fps}
      width={video.width}
      height={video.height}
    />
    <Composition
      id="Guide"
      component={Guide}
      durationInFrames={GUIDE_DURATION}
      fps={video.fps}
      width={video.width}
      height={video.height}
    />
  </>
);
