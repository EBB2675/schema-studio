type IconName = 'schema' | 'controls' | 'history' | 'theme';
const paths: Record<IconName, string> = {
  schema: 'M4 3h6v6H4z M14 15h6v6h-6z M14 3h6v6h-6z M7 9v9h7 M10 6h4',
  controls: 'M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6',
  history: 'M4 5v5h5 M4 10a8 8 0 1 1 1 8 M12 7v5l3 2',
  theme: 'M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9Z',
};
export default function WorkbenchIcon({ name }: { name: IconName }) {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
