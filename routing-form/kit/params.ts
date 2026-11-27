import { defineParams } from "@sveltejs/kit/params";
import { isSection } from "../shared/destinations.ts";

export const params = defineParams({ section: (value) => isSection(value) ? value : undefined });
