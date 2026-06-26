import { NextResponse } from "next/server";
import { auth } from "@/auth";

type AuthOk = {
  githubId: string;
};

type AuthFailed = {
  response: NextResponse;
};

export async function requireGithubId(): Promise<AuthOk | AuthFailed> {
  try {
    const session = await auth();
    const githubId = session?.user?.githubId;
    if (!githubId) {
      return {
        response: NextResponse.json(
          { error: "Not signed in" },
          { status: 401 },
        ),
      };
    }
    return { githubId };
  } catch (err) {
    console.error("Authentication lookup failed", err);
    return {
      response: NextResponse.json(
        { error: "Authentication failed; please sign in again" },
        { status: 401 },
      ),
    };
  }
}
