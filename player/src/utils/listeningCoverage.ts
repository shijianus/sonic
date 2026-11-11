type PlayedRange = [start: number, end: number]

function mergePlayedRanges(archived: PlayedRange[], played?: TimeRanges): PlayedRange[] {
  const ranges = [...archived]
  if (played) {
    for (let index = 0; index < played.length; index++) {
      const start = played.start(index)
      const end = played.end(index)
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        ranges.push([start, end])
      }
    }
  }
  ranges.sort(([a], [b]) => a - b)

  const merged: PlayedRange[] = []
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}

/** Keep the browser's actual playback coverage across reloads of the same track. */
export class ListeningCoverage {
  private archived: PlayedRange[] = []

  archive(played?: TimeRanges) {
    this.archived = mergePlayedRanges(this.archived, played)
  }

  seconds(played?: TimeRanges): number {
    return mergePlayedRanges(this.archived, played).reduce((sum, [start, end]) => sum + end - start, 0)
  }
}
