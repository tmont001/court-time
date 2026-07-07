// Marketing route template — wraps each page in a subtle entrance animation.
// template.tsx re-mounts on every navigation within the (marketing) group,
// so the animation re-plays when visitors move between pages.
// The (app) layout is unaffected — this file only applies here.

export default function MarketingTemplate({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="mkt-page-enter">{children}</div>;
}
