"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Comment,
  listComments,
  createComment,
} from "@/lib/comments-api";
import { CommentList } from "./CommentList";
import { CommentInput } from "./CommentInput";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { MessageSquare } from "lucide-react";

interface CommentDrawerProps {
  objectId: string;
  objectType: string;
  projectId?: string;
  /** Increment to force a re-fetch (e.g. after an inline comment is created). */
  refreshNonce?: number;
}

/** Comments + loading live in ONE state object so finishing a fetch is a
 *  single state update — no chained loading->comments renders. */
interface CommentsState {
  comments: Comment[];
  loading: boolean;
}

const EMPTY_COMMENTS: CommentsState = { comments: [], loading: false };

export function CommentDrawer({
  objectId,
  objectType,
  projectId,
  refreshNonce = 0,
}: CommentDrawerProps) {
  const [open, setOpen] = useState(false);
  const [{ comments, loading }, setCommentsState] =
    useState<CommentsState>(EMPTY_COMMENTS);

  const fetchComments = useCallback(async () => {
    setCommentsState((prev) => ({ ...prev, loading: true }));
    try {
      const result = await listComments(objectId, objectType);
      setCommentsState({ comments: result, loading: false });
    } catch {
      // Keep whatever was loaded; just stop the spinner (previous behavior).
      setCommentsState((prev) => ({ ...prev, loading: false }));
    }
  }, [objectId, objectType]);

  // Opening the drawer is a user event — fetch here instead of reacting to
  // our own `open` state from an effect.
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (nextOpen) {
        fetchComments();
      }
    },
    [fetchComments],
  );

  // Re-fetch when the fetch inputs change externally (different object, or a
  // comment was created elsewhere and the parent bumped refreshNonce). This
  // is resyncing with external inputs, not using state as an event handler —
  // and it only re-runs when an input actually changed, staying quiet on
  // mount and while closed (the next open fetches fresh data anyway).
  const prevInputsRef = useRef({ objectId, objectType, refreshNonce });
  useEffect(() => {
    const prev = prevInputsRef.current;
    if (
      prev.objectId === objectId &&
      prev.objectType === objectType &&
      prev.refreshNonce === refreshNonce
    ) {
      return;
    }
    prevInputsRef.current = { objectId, objectType, refreshNonce };
    if (open) {
      fetchComments();
    }
  }, [objectId, objectType, refreshNonce, open, fetchComments]);

  const handleSubmit = useCallback(
    async (content: string) => {
      await createComment({
        object_id: objectId,
        object_type: objectType,
        content,
        project_id: projectId,
        author_id: "current-user",
        author_name: "You",
      });
      fetchComments();
    },
    [objectId, objectType, projectId, fetchComments],
  );

  const commentCount = comments.length;

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="xs"
          aria-label={`Comments (${commentCount})`}
        >
          <MessageSquare className="h-3 w-3" />
          Comments
          {commentCount > 0 && (
            <span className="ml-0.5 rounded-full bg-primary px-1.5 text-[10px] font-medium text-primary-foreground">
              {commentCount}
            </span>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-[380px] p-0 flex flex-col">
        <SheetHeader className="shrink-0 border-b px-4 py-3">
          <SheetTitle className="text-sm">
            Comments
            {commentCount > 0 && (
              <span className="ml-1.5 text-muted-foreground">
                ({commentCount})
              </span>
            )}
          </SheetTitle>
        </SheetHeader>
        {loading ? (
          <div className="flex flex-1 items-center justify-center">
            <div className="text-sm text-muted-foreground">Loading...</div>
          </div>
        ) : (
          <CommentList
            comments={comments}
            onCommentDeleted={fetchComments}
            onReactionToggled={fetchComments}
          />
        )}
        <CommentInput onSubmit={handleSubmit} />
      </SheetContent>
    </Sheet>
  );
}
