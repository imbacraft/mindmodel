package shop;

import org.springframework.jms.annotation.JmsListener;
import org.springframework.jms.core.JmsTemplate;

public class AuditListener {

  private JmsTemplate jmsTemplate;

  @JmsListener(destination = "${audit.queue:audit}")
  public void onAudit(String payload) {
    jmsTemplate.convertAndSend("invoices", payload);
  }
}
