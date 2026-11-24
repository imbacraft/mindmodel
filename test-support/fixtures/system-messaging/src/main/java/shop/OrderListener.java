package shop;

import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;

@Component
public class OrderListener {

  private final KafkaTemplate<Long, Order> template;

  public OrderListener(KafkaTemplate<Long, Order> template) {
    this.template = template;
  }

  @KafkaListener(id = "o", topics = "orders", groupId = "shop")
  public void onOrder(Order order) {
    template.send("payment-orders", order.getId(), order);
  }
}
