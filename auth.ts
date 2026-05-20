import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [GitHub],
  trustHost: true,
  callbacks: {
    async jwt({ token, profile }) {
      if (profile?.id) {
        token.githubId = String(profile.id);
      }
      return token;
    },
    async session({ session, token }) {
      if (token?.githubId) {
        session.user = {
          ...session.user,
          githubId: token.githubId as string,
        };
      }
      return session;
    },
  },
});

declare module "next-auth" {
  interface Session {
    user: {
      name?: string | null;
      email?: string | null;
      image?: string | null;
      githubId?: string;
    };
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    githubId?: string;
  }
}
