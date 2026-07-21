import Header from "@/components/Header";

export default function LessonsLoading() {
  return (
    <>
      <Header screenTitle="Lesson Requests" />
      <div className="overflow-y-auto" style={{ height: "var(--page-fill-height)" }}>
        <div className="md:max-w-2xl md:mx-auto">
          <div className="px-4 pt-4 pb-2 flex items-center justify-between">
            <div className="h-4 w-32 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
            <div className="h-8 w-28 bg-gray-200 dark:bg-gray-700 rounded-lg animate-pulse" />
          </div>
          {[1, 2, 3].map(i => (
            <div key={i} className="ct-card mx-4 mb-3 px-4 py-4 space-y-2 animate-pulse">
              <div className="h-4 w-24 bg-gray-200 dark:bg-gray-700 rounded" />
              <div className="h-3 w-40 bg-gray-100 dark:bg-gray-800 rounded" />
              <div className="h-3 w-32 bg-gray-100 dark:bg-gray-800 rounded" />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
