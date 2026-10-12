export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[var(--content-max-rep)] flex-col justify-center gap-8 px-[var(--gutter-rep)] py-10">
      <p className="text-title-m">Canvass</p>
      {children}
    </main>
  );
}
