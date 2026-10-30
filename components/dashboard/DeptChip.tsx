import { departmentStyle } from "@/lib/news/departments";
import type { StoryDepartment } from "@/lib/news/types";

/** Pastel department tag with ink text. */
export function DeptChip({ department, className = "" }: { department: StoryDepartment | null; className?: string }) {
  const style = departmentStyle(department?.slug);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[11px] font-medium uppercase leading-4 tracking-wide text-ink ${className}`}
      style={{ backgroundColor: style.chip }}
    >
      {department?.name ?? "General"}
    </span>
  );
}
