import { useEffect, useRef, useState } from 'react';
import { auth } from '../api';
import StatusBadge from './StatusBadge';

// Streams logs over WebSocket (history first, then live).
export default function LogViewer({ deploymentId }: { deploymentId: string }) {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState('');
  const [connected, setConnected] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLines([]);
    setStatus('');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws/logs?deploymentId=${deploymentId}&token=${auth.get()}`);
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'log') setLines((l) => [...l, msg.line]);
      if (msg.type === 'status') setStatus(msg.status);
    };
    return () => ws.close();
  }, [deploymentId]);

  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [lines]);

  return (
    <div className="rounded-lg border border-slate-800 bg-black">
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2 text-xs text-slate-400">
        <span>Deployment {deploymentId.slice(0, 8)}</span>
        <span className="flex items-center gap-2">
          {status && <StatusBadge status={status} />}
          <span className={connected ? 'text-emerald-400' : 'text-slate-500'}>{connected ? '● live' : '○ closed'}</span>
        </span>
      </div>
      <div ref={box} className="h-80 overflow-auto p-3 font-mono text-xs leading-5 text-slate-300">
        {lines.length === 0 && <span className="text-slate-600">Waiting for output…</span>}
        {lines.map((l, i) => (
          <div key={i} className={l.startsWith('==>') ? 'text-sky-300' : l.includes('FAILED') ? 'text-rose-400' : ''}>
            {l}
          </div>
        ))}
      </div>
    </div>
  );
}
