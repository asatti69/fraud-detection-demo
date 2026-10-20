package com.frauddemo.api;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;

/** Reads data/replay.csv, which Phase 1 wrote with each row's Python (ONNX Runtime) score. */
record ReplayData(float[][] features, double[] pythonScores, int[] pythonFlagged, int[] labels) {

    static final Path FILE = Path.of("../data/replay.csv");

    static ReplayData load() {
        try {
            List<String> lines = Files.readAllLines(FILE);
            List<String> header = Arrays.asList(lines.get(0).split(","));
            int[] featureCols = ScoringService.FEATURES.stream().mapToInt(header::indexOf).toArray();
            int scoreCol = header.indexOf("score");
            int flaggedCol = header.indexOf("flagged");
            int classCol = header.indexOf("Class");

            int n = lines.size() - 1;
            float[][] features = new float[n][featureCols.length];
            double[] scores = new double[n];
            int[] flagged = new int[n];
            int[] labels = new int[n];
            for (int r = 0; r < n; r++) {
                String[] cells = lines.get(r + 1).split(",");
                for (int c = 0; c < featureCols.length; c++) {
                    features[r][c] = Float.parseFloat(cells[featureCols[c]]);
                }
                scores[r] = Double.parseDouble(cells[scoreCol]);
                flagged[r] = Integer.parseInt(cells[flaggedCol]);
                labels[r] = Integer.parseInt(cells[classCol]);
            }
            return new ReplayData(features, scores, flagged, labels);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
