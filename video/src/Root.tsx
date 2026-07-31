import React from 'react';
import { Composition } from 'remotion';
import { video, guideVideo } from './brand';
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
    {/* The guide stays 16:9 — it is watched on desktop while following along. */}
    <Composition
      id="Guide"
      component={Guide}
      durationInFrames={GUIDE_DURATION}
      fps={guideVideo.fps}
      width={guideVideo.width}
      height={guideVideo.height}
    />
  </>
);
