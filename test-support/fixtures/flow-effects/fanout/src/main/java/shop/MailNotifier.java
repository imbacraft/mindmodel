package shop;

import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

@Service
public class MailNotifier implements Notifier {
    private final RestTemplate restTemplate;

    public MailNotifier(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    public void send(Notice notice) {
        restTemplate.postForEntity("https://mail.example/notices", notice, Void.class);
    }
}
