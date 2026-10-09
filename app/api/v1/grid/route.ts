import { route } from "@/lib/http";
import { v1Grid } from "@/lib/v1";

export const dynamic = "force-dynamic";
export const GET = route(async () => v1Grid());
