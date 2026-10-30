export default function HomeButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="btn secondary icon-btn" type="button" onClick={onClick} aria-label="Back to home" title="Back to home">
      <svg
        aria-hidden
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 10.5 12 3l9 7.5" />
        <path d="M5.5 9v11.5h13V9" />
        <path d="M10 20.5V14h4v6.5" />
      </svg>
    </button>
  );
}
