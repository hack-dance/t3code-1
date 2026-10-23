import { filterApprovalThreads } from "@t3tools/client-runtime/state/thread-requests";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { SidebarInset } from "../components/ui/sidebar";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { useProjects, useThreadShells } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { isElectron } from "../env";

export const Route = createFileRoute("/_chat/approvals")({
  component: ApprovalsPage,
});

function ApprovalsPage() {
  const threads = useThreadShells();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const [host, setHost] = useState("all");
  const [project, setProject] = useState("all");
  const [nowMs, setNowMs] = useState(Date.now);
  const nextDeadline = threads.reduce((next, thread) => {
    const deadline = thread.pendingApproval?.expiresAt;
    return deadline !== undefined && deadline > nowMs ? Math.min(next, deadline) : next;
  }, Infinity);
  useEffect(() => {
    if (!Number.isFinite(nextDeadline)) return;
    const timer = setTimeout(() => setNowMs(Date.now()), Math.max(0, nextDeadline - Date.now()));
    return () => clearTimeout(timer);
  }, [nextDeadline]);
  const selectedProject = projects.find(
    (entry) => JSON.stringify([entry.environmentId, entry.id]) === project,
  );
  const visible =
    project !== "all" && selectedProject === undefined
      ? []
      : filterApprovalThreads(threads, {
          environmentIds: new Set(environments.map((environment) => environment.environmentId)),
          ...(host === "all" ? {} : { environmentId: host }),
          ...(selectedProject
            ? { environmentId: selectedProject.environmentId, projectId: selectedProject.id }
            : {}),
          nowMs,
        });
  return (
    <SidebarInset>
      <WorkspacePageHeader electron={isElectron}>
        <h1 className="text-sm font-medium">Agent approvals</h1>
      </WorkspacePageHeader>
      <main className="flex flex-1 flex-col gap-4 overflow-auto p-6">
        <p className="text-sm text-muted-foreground">
          Pending requests expire after 4 hours. Open the thread to review local actions.
        </p>
        <div className="flex flex-wrap gap-3">
          <Select
            value={host}
            onValueChange={(value) => {
              setHost(value ?? "all");
              setProject("all");
            }}
          >
            <SelectTrigger aria-label="Filter by host">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="all">All hosts</SelectItem>
              {environments.map((environment) => (
                <SelectItem key={environment.environmentId} value={environment.environmentId}>
                  {environment.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Select value={project} onValueChange={(value) => setProject(value ?? "all")}>
            <SelectTrigger aria-label="Filter by project">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="all">All projects</SelectItem>
              {projects
                .filter((entry) => host === "all" || entry.environmentId === host)
                .map((entry) => (
                  <SelectItem
                    key={JSON.stringify([entry.environmentId, entry.id])}
                    value={JSON.stringify([entry.environmentId, entry.id])}
                  >
                    {entry.title}
                  </SelectItem>
                ))}
            </SelectPopup>
          </Select>
        </div>
        {visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No pending approvals in this scope. Expired requests are hidden.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {visible.map((thread) => (
              <li
                key={JSON.stringify([thread.environmentId, thread.id])}
                className="rounded-lg border border-border p-4"
              >
                <p className="font-medium">{thread.title}</p>
                <p className="text-sm text-muted-foreground">
                  {
                    environments.find((entry) => entry.environmentId === thread.environmentId)
                      ?.label
                  }{" "}
                  ·{" "}
                  {
                    projects.find(
                      (entry) =>
                        entry.environmentId === thread.environmentId &&
                        entry.id === thread.projectId,
                    )?.title
                  }
                </p>
                <p className="text-xs text-muted-foreground">
                  Pending · Expires {new Date(thread.pendingApproval!.expiresAt).toLocaleString()}
                </p>
                <Link
                  to="/$environmentId/$threadId"
                  params={{ environmentId: thread.environmentId, threadId: thread.id }}
                  className="text-sm underline"
                >
                  Open thread
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </SidebarInset>
  );
}
