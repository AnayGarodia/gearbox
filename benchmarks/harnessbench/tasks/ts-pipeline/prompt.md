The data pipeline has two bugs that work together to produce wrong output:
1. `src/transform.ts`: `normalize` divides by the array maximum but uses the MINIMUM instead.
2. `src/pipeline.ts`: `runPipeline` applies transforms in the wrong order — it normalizes before filtering, so the filter threshold is applied to raw values but the output uses normalized values.

Fix both files: normalize should divide by the maximum, and the pipeline should filter first then normalize.

Files to edit: `src/transform.ts` and `src/pipeline.ts`
