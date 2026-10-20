package com.frauddemo.api;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtSession;
import jakarta.annotation.PreDestroy;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.stream.IntStream;
import java.util.stream.Stream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import tools.jackson.databind.json.JsonMapper;

/**
 * Loads the Phase 1 ONNX model once and scores raw transactions with it.
 * Feature engineering and scaling live inside the ONNX file, so this class only
 * puts the 30 raw fields in the right order.
 */
@Service
public class ScoringService {

    private static final Logger log = LoggerFactory.getLogger(ScoringService.class);

    /** Model input order, matching the CSV columns: Time, V1..V28, Amount. */
    public static final List<String> FEATURES = Stream.of(
            Stream.of("Time"),
            IntStream.rangeClosed(1, 28).mapToObj(i -> "V" + i),
            Stream.of("Amount")).flatMap(s -> s).toList();

    private final OrtEnvironment env;
    private final OrtSession session;
    private final Path modelPath;
    private final String modelVersion;
    private final String metricsJson;
    private final double threshold;

    public ScoringService(@Value("${fraud.model-path}") String modelPath,
                          @Value("${fraud.metrics-path}") String metricsPath) throws IOException, OrtException {
        this.modelPath = Path.of(modelPath).toAbsolutePath().normalize();
        Path metrics = Path.of(metricsPath).toAbsolutePath().normalize();

        byte[] modelBytes = Files.readAllBytes(this.modelPath);
        this.modelVersion = sha256(modelBytes).substring(0, 12);
        this.metricsJson = Files.readString(metrics);
        // The alert threshold was chosen on the validation set in Phase 1; we serve exactly that value.
        this.threshold = JsonMapper.builder().build().readTree(metricsJson).get("threshold").asDouble();

        this.env = OrtEnvironment.getEnvironment();
        this.session = env.createSession(modelBytes, new OrtSession.SessionOptions());

        log.atInfo()
                .addKeyValue("event", "model_loaded")
                .addKeyValue("model_path", this.modelPath.toString())
                .addKeyValue("model_version", modelVersion)
                .addKeyValue("threshold", threshold)
                .log("Loaded ONNX fraud model");
    }

    /** Scores a batch of raw transactions, each a float[30] in {@link #FEATURES} order. */
    public float[] score(float[][] rows) throws OrtException {
        try (OnnxTensor input = OnnxTensor.createTensor(env, rows);
             OrtSession.Result result = session.run(Map.of("transactions", input))) {
            return (float[]) result.get(0).getValue();
        }
    }

    public float score(float[] row) throws OrtException {
        return score(new float[][] {row})[0];
    }

    public double threshold() {
        return threshold;
    }

    public String modelVersion() {
        return modelVersion;
    }

    public String modelFile() {
        return modelPath.getFileName().toString();
    }

    public String metricsJson() {
        return metricsJson;
    }

    @PreDestroy
    public void close() throws OrtException {
        session.close();
    }

    private static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
