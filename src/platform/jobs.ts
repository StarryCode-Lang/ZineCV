import type { JobMaterial } from "../../src-tauri/src/domain/bindings/JobMaterial";
import type { JobMaterialListResult } from "../../src-tauri/src/domain/bindings/JobMaterialListResult";
import type { DocumentJobLink } from "../../src-tauri/src/domain/bindings/DocumentJobLink";
import { nativeInvoke } from "./ipc";
import { captureDocumentHostTarget, nativeClient } from "./workspace";

export type JobMaterialInput = Pick<JobMaterial, "title" | "company" | "jobDescription" | "sourceNote">;
export const jobMaterialReferenceId = (material: Pick<JobMaterial, "id" | "revision">) => `job-material:${material.id}:${material.revision}`;

export function captureJobTarget() {
  const target = captureDocumentHostTarget();
  return { ...target, expectedEpoch: target.hostEpoch };
}

// Prepare before any asynchronous work. The returned closure retains the exact
// command ID and request for a lost-acknowledgement retry.
function prepareJobWrite<T>(command: "job_material_save" | "job_material_link" | "job_material_delete" | "job_material_unlink", payload: Record<string, unknown>) {
  const target = captureJobTarget();
  const request = structuredClone({
    commandId: crypto.randomUUID(), documentId: target.cursor.documentId,
    expectedEpoch: target.expectedEpoch, ...payload,
  });
  if (command === "job_material_link") {
    delete (request as Record<string, unknown>).documentId;
    delete (request as Record<string, unknown>).expectedEpoch;
    Object.assign(request, { cursor: target.cursor });
  }
  return async (): Promise<T> => {
    nativeClient.assertTarget(target);
    const result = await nativeInvoke(command, { request: structuredClone(request) }) as T;
    nativeClient.assertTarget(target);
    return result;
  };
}

export async function loadJobMaterials(): Promise<JobMaterialListResult> {
  const target = captureJobTarget();
  const result = await nativeInvoke("job_material_list", { documentId: target.cursor.documentId }) as JobMaterialListResult;
  nativeClient.assertTarget(target);
  if (![...result.materials, ...result.links, ...result.revisions].every(item => item.documentId === target.cursor.documentId)) {
    throw new Error("岗位材料返回了不同简历的内容");
  }
  return result;
}

export const prepareJobSave = (input: JobMaterialInput, material: JobMaterial | null) =>
  prepareJobWrite<JobMaterial>("job_material_save", { ...input, jobMaterial: material });

export const prepareJobLink = (material: JobMaterial, branchId: string) =>
  prepareJobWrite<DocumentJobLink>("job_material_link", {
    jobMaterialId: material.id, jobMaterialRevision: material.revision, branchId,
  });

export const prepareJobDelete = (jobMaterialId: string) =>
  prepareJobWrite<void>("job_material_delete", { jobMaterialId });

export const prepareJobUnlink = (linkId: string) =>
  prepareJobWrite<void>("job_material_unlink", { linkId });
