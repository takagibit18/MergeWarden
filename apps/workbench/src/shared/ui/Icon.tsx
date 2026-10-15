type IconName = 'shield' | 'history' | 'repository' | 'file' | 'arrow' | 'refresh' | 'chevron' | 'code' | 'check' | 'clock' | 'link' | 'panel' | 'close' | 'copy' | 'folder' | 'diff' | 'branch';

const paths: Record<IconName, string> = {
  shield: 'M12 3 4.5 6v5.2c0 4.2 2.7 7.7 7.5 9.8 4.8-2.1 7.5-5.6 7.5-9.8V6L12 3Zm-3.5 8.5 2.5 2.5 4.5-5',
  history: 'M4 4v5h5M4.7 8.8A8 8 0 1 1 4 13m8-6v5l3 2',
  repository: 'M8 4h10v16H8M8 4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2m0-4h10M11 7h4',
  file: 'M14 3H6v18h12V7l-4-4Zm0 0v5h4M9 12h6m-6 4h6',
  arrow: 'M19 12H5m6-6-6 6 6 6',
  refresh: 'M20 5v5h-5M4 19v-5h5M5.8 8a7 7 0 0 1 11.7-2L20 10M4 14l2.5 4a7 7 0 0 0 11.7-2',
  chevron: 'm9 5 7 7-7 7',
  code: 'm8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16',
  check: 'm5 12 4 4L19 6',
  clock: 'M12 8v4l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  link: 'm10 14 4-4m-6 3-2 2a3 3 0 0 0 4 4l3-3m-2-3 3-3a3 3 0 0 1 4 4l-2 2',
  panel: 'M4 4h16v16H4V4Zm4 0v16',
  close: 'm6 6 12 12M6 18 18 6',
  copy: 'M8 8h12v12H8V8Zm8-3V3H3v13h2',
  folder: 'M3 6h7l2 2h9v12H3V6Z',
  diff: 'M4 3h16v18H4V3Zm4 5h8m-8 7h8m-4-3v6',
  branch: 'M7 6v11m10-11v3a5 5 0 0 1-5 5H7M9 4a2 2 0 1 1-4 0 2 2 0 0 1 4 0Zm10 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM9 19a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z',
};

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}
