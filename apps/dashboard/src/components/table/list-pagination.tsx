"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";

interface ListPaginationProps {
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
  /** Plural item name for the summary, e.g. "runs" or "task runs". */
  itemName: string;
  onPageChange: (newPage: number) => void;
}

/** Shared list footer: "Showing X–Y of Z <items>" summary and prev/next pager. */
export function ListPagination({
  totalCount,
  page,
  pageSize,
  totalPages,
  itemName,
  onPageChange,
}: ListPaginationProps) {
  const showingFrom = totalCount === 0 ? 0 : page * pageSize + 1;
  const showingTo = Math.min((page + 1) * pageSize, totalCount);

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border px-6 py-3 text-[12px] text-muted-foreground">
      <span>
        {totalCount > 0 && (
          <>Showing <span className="font-mono text-foreground">{showingFrom}{"\u2013"}{showingTo}</span> of </>
        )}
        <span className="font-mono text-foreground">{totalCount}</span> {itemName}
      </span>
      {totalPages > 1 && (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1 px-2 text-[12px] font-normal"
            disabled={page === 0}
            onClick={() => onPageChange(page - 1)}
            data-testid="list-prev-page"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Prev
          </Button>
          <span className="font-mono tabular-nums">
            Page {page + 1} of {totalPages}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1 px-2 text-[12px] font-normal"
            disabled={page >= totalPages - 1}
            onClick={() => onPageChange(page + 1)}
            data-testid="list-next-page"
          >
            Next
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}
