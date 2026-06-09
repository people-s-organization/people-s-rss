import { getRssSupabase } from "./supabase";

type IdentityRow = {
  user_id: string;
};

type UserRow = {
  id: string;
};

export async function getOrCreateAppUserId(
  provider: string,
  providerUserId: string,
): Promise<string> {
  const supabase = getRssSupabase();
  const normalizedProvider = provider.trim();
  const normalizedProviderUserId = providerUserId.trim();
  if (!normalizedProvider || !normalizedProviderUserId) {
    throw new Error("Invalid user identity");
  }

  const existing = await supabase
    .from("user_identities")
    .select("user_id")
    .eq("provider", normalizedProvider)
    .eq("provider_user_id", normalizedProviderUserId)
    .maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  const existingRow = existing.data as IdentityRow | null;
  if (existingRow?.user_id) return existingRow.user_id;

  const createdUser = await supabase
    .from("app_users")
    .insert({})
    .select("id")
    .single();
  if (createdUser.error) throw new Error(createdUser.error.message);
  const userId = (createdUser.data as UserRow).id;

  const createdIdentity = await supabase
    .from("user_identities")
    .insert({
      user_id: userId,
      provider: normalizedProvider,
      provider_user_id: normalizedProviderUserId,
    })
    .select("user_id")
    .single();

  if (!createdIdentity.error) {
    return (createdIdentity.data as IdentityRow).user_id;
  }

  await supabase.from("app_users").delete().eq("id", userId);

  const racedIdentity = await supabase
    .from("user_identities")
    .select("user_id")
    .eq("provider", normalizedProvider)
    .eq("provider_user_id", normalizedProviderUserId)
    .maybeSingle();
  if (racedIdentity.error) throw new Error(racedIdentity.error.message);
  const racedRow = racedIdentity.data as IdentityRow | null;
  if (racedRow?.user_id) return racedRow.user_id;

  throw new Error(createdIdentity.error.message);
}
