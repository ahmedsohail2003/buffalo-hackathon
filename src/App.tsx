import { useEffect } from 'react';
import { PARAMS } from './app/params';
import { getRuntime } from './app/runtime';
import { BayPane } from './ui/BayPane';
import { HandPane } from './ui/HandPane';
import { LogStrip } from './ui/LogStrip';
import { MissionPane } from './ui/MissionPane';
import { TopBar } from './ui/TopBar';

export default function App() {
  useEffect(() => {
    getRuntime().start();
  }, []);
  return (
    <div className={`app${PARAMS.present ? ' present' : ''}`}>
      <TopBar />
      <HandPane />
      <BayPane />
      <MissionPane />
      <LogStrip />
    </div>
  );
}
