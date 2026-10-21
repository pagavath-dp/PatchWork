function GitHubMark({ className }: { className: string }) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 .297a12 12 0 0 0-3.793 23.387c.6.111.793-.261.793-.577v-2.234c-3.338.726-4.043-1.416-4.043-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.108-.775.418-1.304.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.536-1.524.117-3.176 0 0 1.008-.323 3.301 1.23a11.53 11.53 0 0 1 6.006 0c2.291-1.553 3.297-1.23 3.297-1.23.655 1.652.243 2.873.12 3.176.77.84 1.235 1.91 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576A12 12 0 0 0 12 .297" />
    </svg>
  );
}

const features = [
  {
    label: "Tasks",
    description: "Plan tasks together and follow progress from list to board.",
  },
  {
    label: "GitHub",
    description: "See linked GitHub issues, pull requests, and repository activity.",
  },
  {
    label: "Health",
    description: "Explore clear, evidence-backed project health insights.",
  },
];

export default function LoginPage() {
  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col px-6 sm:px-10 lg:px-12">
      <header className="flex items-center justify-between border-b border-border py-6">
        <div className="flex items-center gap-3">
          <span aria-hidden="true" className="grid size-8 grid-cols-2 gap-0.5 rounded-[6px] bg-foreground p-1.5">
            <span className="rounded-[1px] bg-white" />
            <span className="rounded-[1px] bg-primary" />
            <span className="rounded-[1px] bg-primary" />
            <span className="rounded-[1px] bg-white" />
          </span>
          <span className="text-base font-semibold tracking-[-0.035em]">PatchWork</span>
        </div>
        <span className="font-mono text-xs text-muted-foreground">Sign in</span>
      </header>

      <div className="grid flex-1 items-center gap-10 py-12 lg:grid-cols-[minmax(0,1.15fr)_minmax(20rem,0.85fr)] lg:gap-x-20 lg:gap-y-0">
        <div className="max-w-xl lg:self-end">
          <h1 className="max-w-lg text-[clamp(2.25rem,4vw,3.5rem)] leading-[1.12] font-medium tracking-[-0.045em]">
            Track the work. Understand the project.
          </h1>
          <p className="mt-6 max-w-lg text-base leading-7 text-muted-foreground">
            PatchWork brings team tasks, GitHub activity and evidence-backed project health into one workspace.
          </p>
        </div>

        <section aria-labelledby="sign-in-title" className="rounded-[10px] border border-border bg-card p-7 sm:p-9 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-center">
          <h2 id="sign-in-title" className="text-2xl font-medium tracking-[-0.035em] text-card-foreground">Sign in to your workspace</h2>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">Use your GitHub account to continue with your team.</p>

          <a href="/auth/github/start" className="mt-8 inline-flex min-h-11 w-full items-center justify-center gap-3 rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-[#4429df] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
            <GitHubMark className="size-4.5" />
            Continue with GitHub
          </a>

          <p className="mt-7 border-t border-border pt-5 text-xs leading-5 text-muted-foreground">
            Sign-in uses your GitHub profile. A workspace owner connects repository access separately through a GitHub App.
          </p>
        </section>

        <dl className="max-w-xl border-t border-border lg:col-start-1 lg:row-start-2 lg:mt-10 lg:self-start">
          {features.map(({ label, description }) => (
            <div key={label} className="grid gap-2 border-b border-border py-4 sm:grid-cols-[6rem_1fr] sm:gap-6">
              <dt className="font-mono text-xs font-medium text-foreground">{label}</dt>
              <dd className="text-sm leading-6 text-muted-foreground">{description}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
