"use client";

// MarketingReveal — wraps children in a scroll-reveal element.
// Uses IntersectionObserver to add .mkt-reveal--visible when the element
// enters the viewport. CSS in globals.css handles the actual transition.
// Respects prefers-reduced-motion at the CSS level (elements are always
// visible under reduced motion regardless of the JS class state).

import { useEffect, useRef } from "react";

interface Props {
  children: React.ReactNode;
  // Optional stagger delay class: "delay-1" | "delay-2" | "delay-3"
  delay?: string;
  className?: string;
  as?: keyof React.JSX.IntrinsicElements;
}

export default function MarketingReveal({
  children,
  delay,
  className = "",
  as: Tag = "div",
}: Props) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            el.classList.add("mkt-reveal--visible");
            observer.unobserve(el); // fire once
          }
        });
      },
      { threshold: 0.1, rootMargin: "0px 0px -40px 0px" }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const cls = ["mkt-reveal", delay, className].filter(Boolean).join(" ");

  return (
    // @ts-expect-error — dynamic tag; JSX.IntrinsicElements type is fine at runtime
    <Tag ref={ref} className={cls}>
      {children}
    </Tag>
  );
}
