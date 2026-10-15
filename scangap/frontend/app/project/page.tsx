"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import ProjectView from "@/components/ProjectView";

function Inner() {
  const id = useSearchParams().get("id");
  if (!id) return <div className="p-4 text-sm text-muted">No project id.</div>;
  return <ProjectView id={id} />;
}

export default function ProjectPage() {
  return (
    <Suspense fallback={<div className="p-4 text-sm text-muted">Loading…</div>}>
      <Inner />
    </Suspense>
  );
}
