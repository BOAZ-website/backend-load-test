package com.boaz.backend.loadtest;

import com.boaz.backend.domain.user.entity.User;
import com.boaz.backend.domain.user.repository.UserRepository;
import com.boaz.backend.global.security.JwtProvider;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.ActiveProfiles;

import java.io.FileWriter;
import java.io.IOException;
import java.util.List;

/**
 * 실행 방법:
 *   ./gradlew test --tests "com.boaz.backend.loadtest.TokenGenerator.generateTokens"
 *              -Dspring.profiles.active=prod,loadtest
 *
 * 전제조건: prod DB에 provider='TEST' 유저 300명이 시드되어 있어야 함 (가이드 2단계)
 * 결과물: k6-script/tokens.csv (커밋 금지 — .gitignore에 포함)
 */
@SpringBootTest
@ActiveProfiles({"prod", "loadtest"})
class TokenGenerator {

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private JwtProvider jwtProvider;

    @Test
    void generateTokens() throws IOException {
        List<User> testUsers = userRepository.findAll().stream()
                .filter(u -> "TEST".equals(u.getProvider()))
                .toList();

        if (testUsers.isEmpty()) {
            throw new IllegalStateException("provider='TEST' 유저가 없습니다. 가이드 2단계(prod 시드)를 먼저 실행하세요.");
        }

        try (FileWriter fw = new FileWriter("k6-script/tokens.csv")) {
            fw.write("userId,token\n");
            for (User user : testUsers) {
                String token = jwtProvider.generateUserAccessToken(user.getId());
                fw.write(user.getId() + "," + token + "\n");
            }
        }

        System.out.printf("tokens.csv 생성 완료: %d명%n", testUsers.size());
    }
}
