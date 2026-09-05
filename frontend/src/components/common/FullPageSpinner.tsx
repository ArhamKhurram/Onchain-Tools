interface FullPageSpinnerProps {
  // Optional extra classes appended to the container (e.g. 'w-full'). The base
  // classes match the block previously inlined across the page components, so
  // rendered output is unchanged when this is omitted.
  className?: string;
}

// Full-page centered loading spinner shared by page-level loading states.
// Renders the exact markup that was duplicated inline across the console pages.
export default function FullPageSpinner({ className }: FullPageSpinnerProps) {
  return (
    <div className={`flex items-center justify-center h-full bg-oct-bg${className ? ` ${className}` : ''}`}>
      <div className="w-6 h-6 border-2 border-oct-accent border-t-transparent rounded-full animate-spin" />
    </div>
  );
}
