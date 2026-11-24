package shop;

import org.springframework.stereotype.Service;

@Service
public class SmsNotifier implements Notifier {
    public void send(Notice notice) {
        log(notice);
    }

    private void log(Notice notice) {
    }
}
