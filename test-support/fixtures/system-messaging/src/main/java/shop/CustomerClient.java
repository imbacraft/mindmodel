package shop;

import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.cloud.client.discovery.DiscoveryClient;

public class CustomerClient {

  private WebClient webClient;
  private DiscoveryClient discoveryClient;

  public void call(int id) {
    webClient.get().uri("http://customers-service/owners/{id}", id).retrieve();
    discoveryClient.getInstances("visits-service");
    post("http://vets-service/api/vet");
  }

  public void post(String url) {
  }
}
