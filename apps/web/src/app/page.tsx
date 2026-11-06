import { DesignGrid } from "@/components/DesignGrid";
import { TabBar } from "@/components/TabBar";

export default function Page() {
  return (
    <>
      <TabBar current={null} />
      <DesignGrid />
    </>
  );
}
