import { setRequestLocale } from "next-intl/server";
import { Reader } from "../components/Reader";

export default async function Page({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  return <Reader />;
}
